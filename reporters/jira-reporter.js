// reporters/jira-reporter.js
const axios = require('axios');
require('dotenv').config();

class JiraReporter {
  constructor(options = {}) {
    // Validate required environment variables
    const requiredEnv = [
      { key: 'JIRA_BASE_URL', value: process.env.JIRA_BASE_URL },
      { key: 'JIRA_EMAIL', value: process.env.JIRA_EMAIL },
      { key: 'JIRA_API_TOKEN', value: process.env.JIRA_API_TOKEN }
    ];
    const missing = requiredEnv.filter(e => !e.value).map(e => e.key);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables for JiraReporter: ${missing.join(', ')}`
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
    
    this.projectKey = process.env.JIRA_PROJECT_KEY || 'SCRUM';
    this.testResults = [];
    this.options = options;
  }

  onBegin(config, suite) {
    console.log(`Starting Playwright tests with Jira integration...`);
    console.log(`Will sync results to Jira project: ${this.projectKey}`);
  }

  onTestEnd(test, result) {
    // Extract test ID from test title (e.g., "VAL-001: Page Load and Initial State")
    const testIdPattern = /(VAL-\d+):/;
    const testIdMatch = test.title.match(testIdPattern);
    if (!testIdMatch) {
      console.log(`No Jira test ID found in: ${test.title}`);
      return;
    }

    const testId = testIdMatch[1];
    const projectName = test.parent?.project()?.name || 'unknown';
    const testData = {
      testId,
      title: test.title,
      project: projectName,
      status: result.status,
      duration: result.duration,
      error: result.error?.message,
      file: test.location?.file,
      line: test.location?.line,
      retry: result.retry,
      startTime: result.startTime,
      attachments: result.attachments
    };

    console.log(` Test completed: ${testId} [${projectName}] → ${result.status.toUpperCase()}`);
    this.testResults.push(testData);
    
    // Sync immediately for each test (optional - you can batch at the end)
    if (this.options.syncImmediately !== false) {
      this.syncTestToJira(testData);
    }
  }

  async onEnd(result) {
    console.log(`\n📈 Test execution completed. Syncing ${this.testResults.length} results to Jira...`);
    
    // Debug: Show what results we collected
    const statusCounts = {};
    this.testResults.forEach(t => {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    });
    console.log(` Result breakdown: ${JSON.stringify(statusCounts)}`);
    
    if (this.options.syncImmediately === false) {
      // Batch sync all results
      await this.syncAllTestsToJira();
    }

    // Create or update test execution
    await this.createTestExecution(result);
    
    console.log(' Jira sync completed!');
  }

  async syncTestToJira(testData) {
    try {
      // First, try to find existing issue
      const issue = await this.findJiraIssue(testData.testId);
      
      if (issue) {
        await this.updateTestStatus(issue.key, testData);
        await this.addTestComment(issue.key, testData);
      } else {
        console.log(`Issue ${testData.testId} not found in Jira`);
      }
    } catch (error) {
      console.error(`Failed to sync ${testData.testId} to Jira:`, error.message);
    }
  }

  async findJiraIssue(testId) {
    // For now, skip individual issue lookup since we need to map VAL-001 to SCRUM-X format
    // This is a known limitation due to the search API issues we encountered
    console.log(`Skipping issue lookup for ${testId} - will create execution summary instead`);
    return null;
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
        
        console.log(`Updated ${issueKey} status to: ${jiraStatus}`);
      }
    } catch (error) {
      console.error(`Error updating status for ${issueKey}:`, error.message);
    }
  }

  async addTestComment(issueKey, testData) {
    try {
      const duration = Math.round(testData.duration / 1000 * 100) / 100;
      
      let comment = `**Test Execution Result**\n\n`;
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
      
      console.log(`Added comment to ${issueKey}`);
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
      
      console.log(`Created test execution issue: ${response.data.key}`);
      return response.data;
    } catch (error) {
      console.error('Error creating test execution:', error.message);
    }
  }

  generateExecutionSummary(result) {
    const passed = this.testResults.filter(t => t.status === 'passed').length;
    const failed = this.testResults.filter(t => t.status === 'failed').length;
    const skipped = this.testResults.filter(t => t.status === 'skipped').length;
    const interrupted = this.testResults.filter(t => t.status === 'interrupted').length;
    const timedOut = this.testResults.filter(t => t.status === 'timedOut').length;
    
    const totalDuration = Math.round(result.duration / 1000);
    const successRate = this.testResults.length > 0 ? Math.round((passed / this.testResults.length) * 100) : 0;
    
    // Group tests by project for better reporting
    const byProject = {};
    this.testResults.forEach(t => {
      if (!byProject[t.project]) byProject[t.project] = [];
      byProject[t.project].push(t);
    });
    
    let summary = `Automated Test Execution Summary:
    
 RESULTS OVERVIEW:
• Passed: ${passed}
• Failed: ${failed}
• Skipped: ${skipped}`;

    if (interrupted > 0) summary += `\n• Interrupted: ${interrupted}`;
    if (timedOut > 0) summary += `\n• Timed Out: ${timedOut}`;
    
    summary += `
• Total: ${this.testResults.length}
• Duration: ${totalDuration}s
• Success Rate: ${successRate}%

 DETAILED RESULTS:`;

    // Add results grouped by project
    Object.keys(byProject).forEach(project => {
      summary += `\n\n[${project.toUpperCase()}]:`;
      byProject[project].forEach(t => {
        const duration = Math.round(t.duration / 1000 * 100) / 100;
        summary += `\n• ${t.testId}: ${t.status.toUpperCase()} (${duration}s)`;
        if (t.error && t.status === 'failed') {
          summary += `\n   Error: ${t.error.substring(0, 100)}${t.error.length > 100 ? '...' : ''}`;
        }
      });
    });
    
    return summary;
  }

  async syncAllTestsToJira() {
    console.log('Batch syncing all test results...');
    for (const testData of this.testResults) {
      await this.syncTestToJira(testData);
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

module.exports = JiraReporter;
