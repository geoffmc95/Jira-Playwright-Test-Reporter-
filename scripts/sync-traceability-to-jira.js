// scripts/sync-traceability-to-jira.js
const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');
require('dotenv').config();

class TraceabilityMatrixSync {
  constructor() {
    // Validate required environment variables
    const requiredEnv = [
      { key: 'JIRA_BASE_URL', value: process.env.JIRA_BASE_URL },
      { key: 'JIRA_EMAIL', value: process.env.JIRA_EMAIL },
      { key: 'JIRA_API_TOKEN', value: process.env.JIRA_API_TOKEN }
    ];
    
    const missing = requiredEnv.filter(e => !e.value).map(e => e.key);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}`
      );
    }

    this.jiraConfig = {
      baseURL: process.env.JIRA_BASE_URL,
      headers: {
        'Authorization': `Basic ${Buffer.from(
          `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
        ).toString('base64')}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };
    
    this.projectKey = process.env.JIRA_PROJECT_KEY || 'VAL';
    this.dryRun = process.env.DRY_RUN === 'true';
    this.updateExisting = process.env.UPDATE_EXISTING !== 'false';
  }

  async syncTraceabilityMatrix(csvFilePath) {
    console.log(`Starting traceability matrix sync to Jira project: ${this.projectKey}`);
    console.log(`Reading CSV file: ${csvFilePath}`);
    console.log(`Dry run mode: ${this.dryRun ? 'ENABLED' : 'DISABLED'}`);
    
    try {
      // Verify Jira connection and project
      await this.verifyJiraConnection();
      
      // Read and parse CSV
      const testCases = await this.parseCsvFile(csvFilePath);
      console.log(`Found ${testCases.length} test cases to sync`);
      
      // Sync each test case
      const results = await this.syncTestCases(testCases);
      
      // Print summary
      this.printSummary(results);
      
    } catch (error) {
      console.error('Sync failed:', error.message);
      throw error;
    }
  }

  async verifyJiraConnection() {
    try {
      console.log('Testing Jira connection...');
      
      // Test: Get project info
      const projectResponse = await axios.get(`/rest/api/3/project/${this.projectKey}`, this.jiraConfig);
      console.log(`Connected to Jira project: ${projectResponse.data.name}`);
      console.log(`Note: Search functionality disabled due to endpoint limitations`);
      
      return projectResponse.data;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`Project ${this.projectKey} not found. Please create it first.`);
      }
      throw new Error(`Failed to connect to Jira: ${error.response?.status} - ${error.message}`);
    }
  }

  async parseCsvFile(csvFilePath) {
    return new Promise((resolve, reject) => {
      const testCases = [];
      
      fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (row) => {
          // Validate required fields
          if (!row['Test ID'] || !row['Test Name']) {
            console.warn(`Skipping row with missing Test ID or Test Name:`, row);
            return;
          }
          
          testCases.push({
            testId: row['Test ID'].trim(),
            testName: row['Test Name'].trim(),
            requirement: row['Requirement/Feature']?.trim() || '',
            testMethod: row['Test Method']?.trim() || '',
            pomMethods: row['POM Methods Used']?.trim() || '',
            verificationPoints: row['Verification Points']?.trim() || '',
            status: row['Status']?.trim() || 'To Do',
            priority: row['Priority']?.trim() || 'Medium'
          });
        })
        .on('end', () => {
          console.log(`Parsed ${testCases.length} test cases from CSV`);
          resolve(testCases);
        })
        .on('error', reject);
    });
  }

  async syncTestCases(testCases) {
    console.log('Starting test case synchronization...');
    const results = {
      created: [],
      updated: [],
      skipped: [],
      errors: []
    };

    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      console.log(`\nProcessing ${i + 1}/${testCases.length}: ${testCase.testId}`);
      
      try {
        // Check if issue already exists
        const existingIssue = await this.findExistingIssue(testCase.testId);
        
        if (existingIssue) {
          if (this.updateExisting) {
            const result = await this.updateJiraIssue(existingIssue.key, testCase);
            results.updated.push({ testId: testCase.testId, key: existingIssue.key, result });
          } else {
            console.log(`Issue ${testCase.testId} already exists, skipping`);
            results.skipped.push({ testId: testCase.testId, key: existingIssue.key });
          }
        } else {
          const result = await this.createJiraIssue(testCase);
          results.created.push({ testId: testCase.testId, key: result?.key, result });
        }
        
        // Rate limiting - avoid overwhelming Jira
        await this.sleep(200);
        
      } catch (error) {
        console.error(`Error processing ${testCase.testId}:`, error.message);
        results.errors.push({ testId: testCase.testId, error: error.message });
      }
    }

    return results;
  }

  async findExistingIssue(testId) {
    // Since search endpoint returns 410, skip searching and assume no existing issues
    // This means the script will always try to create new issues
    console.log(`Skipping search for ${testId} (search endpoint not available)`);
    return null;
  }

  async createJiraIssue(testCase) {
    if (this.dryRun) {
      console.log(`[DRY RUN] Would create issue for ${testCase.testId}`);
      return { key: 'DRY-RUN-001' };
    }

    const issueData = {
      fields: {
        project: { key: this.projectKey },
        summary: `${testCase.testId}: ${testCase.testName}`,
        description: this.generateDescription(testCase),
        issuetype: { name: 'Story' }, // Change to 'Test' if you have that issue type
        priority: { name: this.mapPriority(testCase.priority) },
        labels: ['automated-test', 'playwright', testCase.priority.toLowerCase()]
      }
    };

    try {
      const response = await axios.post('/rest/api/3/issue', issueData, this.jiraConfig);
      console.log(`Created issue: ${response.data.key}`);
      return response.data;
    } catch (error) {
      console.error('Error creating issue:', error.response?.data || error.message);
      throw error;
    }
  }

  async updateJiraIssue(issueKey, testCase) {
    if (this.dryRun) {
      console.log(`[DRY RUN] Would update issue ${issueKey}`);
      return { key: issueKey };
    }

    const updateData = {
      fields: {
        summary: `${testCase.testId}: ${testCase.testName}`,
        description: this.generateDescription(testCase),
        priority: { name: this.mapPriority(testCase.priority) }
      }
    };

    try {
      await axios.put(`/rest/api/3/issue/${issueKey}`, updateData, this.jiraConfig);
      console.log(`Updated issue: ${issueKey}`);
      return { key: issueKey };
    } catch (error) {
      console.error('Error updating issue:', error.response?.data || error.message);
      throw error;
    }
  }

  generateDescription(testCase) {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Test Information" }]
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Requirement/Feature: ", marks: [{ type: "strong" }] },
            { type: "text", text: testCase.requirement }
          ]
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Test Method: ", marks: [{ type: "strong" }] },
            { type: "text", text: testCase.testMethod }
          ]
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "POM Methods Used" }]
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: testCase.pomMethods }]
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Verification Points" }]
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: testCase.verificationPoints }]
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Status: ", marks: [{ type: "strong" }] },
            { type: "text", text: testCase.status }
          ]
        }
      ]
    };
  }

  mapPriority(csvPriority) {
    const priorityMap = {
      'High': 'High',
      'Medium': 'Medium', 
      'Low': 'Low',
      'Critical': 'Highest',
      'Minor': 'Lowest'
    };
    
    return priorityMap[csvPriority] || 'Medium';
  }

  printSummary(results) {
    console.log('\nSYNCHRONIZATION SUMMARY');
    console.log('==========================');
    console.log(`Created: ${results.created.length}`);
    console.log(`Updated: ${results.updated.length}`);
    console.log(`Skipped: ${results.skipped.length}`);
    console.log(`Errors: ${results.errors.length}`);
    
    if (results.created.length > 0) {
      console.log('\nCreated Issues:');
      results.created.forEach(r => console.log(`  • ${r.testId} → ${r.key}`));
    }
    
    if (results.updated.length > 0) {
      console.log('\nUpdated Issues:');
      results.updated.forEach(r => console.log(`  • ${r.testId} → ${r.key}`));
    }
    
    if (results.errors.length > 0) {
      console.log('\nErrors:');
      results.errors.forEach(r => console.log(`  • ${r.testId}: ${r.error}`));
    }
    
    console.log('\nSync completed!');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI usage
async function main() {
  const csvFile = process.argv[2] || 'traceability-matrix.csv';
  
  if (!fs.existsSync(csvFile)) {
    console.error(`CSV file not found: ${csvFile}`);
    console.log('Usage: node sync-traceability-to-jira.js [csv-file-path]');
    process.exit(1);
  }

  try {
    const sync = new TraceabilityMatrixSync();
    await sync.syncTraceabilityMatrix(csvFile);
  } catch (error) {
    console.error('Sync failed:', error.message);
    process.exit(1);
  }
}

// Export for use as module
module.exports = TraceabilityMatrixSync;

// Run if called directly
if (require.main === module) {
  main();
}
