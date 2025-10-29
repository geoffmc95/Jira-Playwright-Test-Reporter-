// reporters/jira-reporter.js
const axios = require('axios');
require('dotenv').config();

class JiraReporter {
  constructor(options = {}) {
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
    this.testResults = [];
    this.options = options;
  }

  onBegin(config, suite) {
    console.log(`🚀 Starting Playwright tests with Jira integration...`);
    console.log(`📊 Will sync results to Jira project: ${this.projectKey}`);
  }

  onTestEnd(test, result) {
    // Extract test ID from test title (e.g., "VAL-001: Page Load and Initial State")
    const testIdMatch = test.title.match(/(VAL-\d+):/);
    if (!testIdMatch) {
      console.log(`⚠️  No Jira test ID found in: ${test.title}`);
      return;
    }

    const testId = testIdMatch[1];
    const testData = {
      testId,
      title: test.title,
      status: result.status,
      duration: result.duration,
      error: result.error?.message,
      file: test.location?.file,
      line: test.location?.line,
      retry: result.retry,
      startTime: result.startTime,
      attachments: result.attachments
    };

    this.testResults.push(testData);
    
    // Sync immediately for each test (optional - you can batch at the end)
    if (this.options.syncImmediately !== false) {
      this.syncTestToJira(testData);
    }
  }

  async onEnd(result) {
    console.log(`\n📈 Test execution completed. Syncing ${this.testResults.length} results to Jira...`);
    
    if (this.options.syncImmediately === false) {
      // Batch sync all results
      await this.syncAllTestsToJira();
    }

    // Create or update test execution
    await this.createTestExecution(result);
    
    console.log('✅ Jira sync completed!');
  }

  async syncTestToJira(testData) {
    try {
      // First, try to find existing issue
      const issue = await this.findJiraIssue(testData.testId);
      
      if (issue) {
        await this.updateTestStatus(issue.key, testData);
        await this.addTestComment(issue.key, testData);
      } else {
        console.log(`⚠️  Issue ${testData.testId} not found in Jira`);
      }
    } catch (error) {
      console.error(`❌ Failed to sync ${testData.testId} to Jira:`, error.message);
    }
  }

  async findJiraIssue(testId) {
    try {
      const searchUrl = `/rest/api/3/search`;
      const jql = `project = ${this.projectKey} AND summary ~ "${testId}"`;
      
      const response = await axios.get(searchUrl, {
        ...this.jiraConfig,
        params: { jql, maxResults: 1 }
      });
      
      return response.data.issues[0] || null;
    } catch (error) {
      console.error(`Error searching for issue ${testId}:`, error.message);
      return null;
    }
  }

  async updateTestStatus(issueKey, testData) {
    try {
      // Map Playwright status to Jira status
      const statusMapping = {
        'passed': 'Done',
        'failed': 'In Progress', 
        'skipped': 'To Do',
        'timedOut': 'In Progress'
      };

      const jiraStatus = statusMapping[testData.status] || 'To Do';
      
      // Get available transitions
      const transitionsResponse = await axios.get(
        `/rest/api/3/issue/${issueKey}/transitions`,
        this.jiraConfig
      );

      const transition = transitionsResponse.data.transitions.find(
        t => t.name === jiraStatus || t.to.name === jiraStatus
      );

      if (transition) {
        await axios.post(
          `/rest/api/3/issue/${issueKey}/transitions`,
          {
            transition: { id: transition.id }
          },
          this.jiraConfig
        );
        
        console.log(`✅ Updated ${issueKey} status to: ${jiraStatus}`);
      }
    } catch (error) {
      console.error(`Error updating status for ${issueKey}:`, error.message);
    }
  }

  async addTestComment(issueKey, testData) {
    try {
      const emoji = testData.status === 'passed' ? '✅' : '❌';
      const duration = Math.round(testData.duration / 1000 * 100) / 100;
      
      let comment = `${emoji} **Test Execution Result**\n\n`;
      comment += `*Status:* ${testData.status.toUpperCase()}\n`;
      comment += `*Duration:* ${duration}s\n`;
      comment += `*Executed:* ${new Date(testData.startTime).toLocaleString()}\n`;
      
      if (testData.retry > 0) {
        comment += `*Retries:* ${testData.retry}\n`;
      }
      
      if (testData.error) {
        comment += `\n*Error:*\n{code}\n${testData.error}\n{code}`;
      }

      await axios.post(
        `/rest/api/3/issue/${issueKey}/comment`,
        {
          body: {
            type: "doc",
            version: 1,
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                text: comment
              }]
            }]
          }
        },
        this.jiraConfig
      );
      
      console.log(`📝 Added comment to ${issueKey}`);
    } catch (error) {
      console.error(`Error adding comment to ${issueKey}:`, error.message);
    }
  }

  async createTestExecution(result) {
    try {
      const summary = `Test Execution - ${new Date().toLocaleDateString()}`;
      const description = this.generateExecutionSummary(result);
      
      const executionIssue = {
        fields: {
          project: { key: this.projectKey },
          summary,
          description: {
            type: "doc",
            version: 1,
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                text: description
              }]
            }]
          },
          issuetype: { name: 'Task' }, // or 'Test Execution' if you have it
          labels: ['playwright', 'automated-test', 'test-execution']
        }
      };

      const response = await axios.post(
        '/rest/api/3/issue',
        executionIssue,
        this.jiraConfig
      );
      
      console.log(`📋 Created test execution issue: ${response.data.key}`);
      return response.data;
    } catch (error) {
      console.error('Error creating test execution:', error.message);
    }
  }

  generateExecutionSummary(result) {
    const passed = this.testResults.filter(t => t.status === 'passed').length;
    const failed = this.testResults.filter(t => t.status === 'failed').length;
    const skipped = this.testResults.filter(t => t.status === 'skipped').length;
    
    return `Automated Test Execution Summary:
    
✅ Passed: ${passed}
❌ Failed: ${failed}
⏭️ Skipped: ${skipped}
📊 Total: ${this.testResults.length}
⏱️ Duration: ${Math.round(result.duration / 1000)}s
🎯 Success Rate: ${Math.round((passed / this.testResults.length) * 100)}%

Test Details:
${this.testResults.map(t => `• ${t.testId}: ${t.status.toUpperCase()}`).join('\n')}`;
  }

  async syncAllTestsToJira() {
    console.log('🔄 Batch syncing all test results...');
    for (const testData of this.testResults) {
      await this.syncTestToJira(testData);
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

module.exports = JiraReporter;