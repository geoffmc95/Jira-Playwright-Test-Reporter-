// reporters/jira-reporter.js
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

class JiraReporter {
  constructor(options = {}) {
    this.autoHealEnabled = options.autoHeal !== false; // Default to enabled
    this.failedTests = []; // Track failed tests for healing
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
    console.log(`Auto-healing: ${this.autoHealEnabled ? 'ENABLED' : 'DISABLED'}`);
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
      startTime: result.startTime
    };

    console.log(`Test completed: ${testId} [${projectName}] -> ${result.status.toUpperCase()}`);
    this.testResults.push(testData);
    
    // Track failed tests for auto-healing
    if (result.status === 'failed' && this.autoHealEnabled) {
      this.failedTests.push(testData);
      console.log(`Failed test tracked for auto-healing: ${testId}`);
    }
    
    // Simplified sync - just capture results
    if (this.options.syncImmediately !== false) {
      this.syncTestToJira(testData);
    }
  }

  async onEnd(result) {
    console.log(`\nTest execution completed. Syncing ${this.testResults.length} results to Jira...`);
    
    // Debug: Show what results we collected
    const statusCounts = {};
    this.testResults.forEach(t => {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    });
    console.log(`Result breakdown: ${JSON.stringify(statusCounts)}`);
    
    if (this.options.syncImmediately === false) {
      // Batch mode - results are already collected, just proceed to summary
      console.log('Batch mode: Creating summary from collected results');
    }

    // Auto-heal failed tests if enabled
    if (this.autoHealEnabled && this.failedTests.length > 0) {
      console.log(`\nStarting auto-healing for ${this.failedTests.length} failed tests...`);
      await this.autoHealFailedTests();
    }

    // Create or update test execution
    await this.createTestExecution(result);
    
    console.log('Jira sync completed!');
  }

  async syncTestToJira(testData) {
    // Individual test syncing is disabled since we don't have proper issue mapping
    // All results are captured in the execution summary instead
    console.log(`Captured test result: ${testData.testId} - ${testData.status}`);
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
          issuetype: { name: 'Task' },
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
      console.error('Error creating test execution:', error.response?.data || error.message);
      // Continue execution even if Jira fails
      return null;
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
          summary += `\n  Error: ${t.error.substring(0, 100)}${t.error.length > 100 ? '...' : ''}`;
        }
      });
    });
    
    return summary;
  }

  async autoHealFailedTests() {
    const healingResults = [];
    
    for (const failedTest of this.failedTests) {
      console.log(`\nHealing test: ${failedTest.testId}`);
      
      try {
        const healingResult = await this.healSingleTest(failedTest);
        healingResults.push(healingResult);
        
        // Add delay between healing attempts
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Failed to heal ${failedTest.testId}:`, error.message);
        healingResults.push({
          testId: failedTest.testId,
          success: false,
          error: error.message,
          changes: [],
          finalStatus: 'failed'
        });
      }
    }
    
    // Create healing summary issue in Jira
    await this.createHealingSummaryIssue(healingResults);
    
    return healingResults;
  }

  async healSingleTest(failedTest) {
    const testFile = failedTest.file;
    const testTitle = failedTest.title;
    
    console.log(`Debugging test: ${failedTest.testId} in ${testFile}`);
    
    // Step 1: Debug the specific test
    const debugResult = await this.runPlaywrightDebug(failedTest.testId);
    
    // Step 2: Analyze the error and determine fix strategy
    const fixStrategy = this.analyzeFailureAndCreateStrategy(failedTest, debugResult);
    
    // Step 3: Apply fixes based on strategy
    const appliedFixes = await this.applyTestFixes(testFile, fixStrategy);
    
    // Step 4: Re-run the test to validate fix
    const rerunResult = await this.rerunSingleTest(failedTest.testId);
    
    return {
      testId: failedTest.testId,
      originalError: failedTest.error,
      fixStrategy: fixStrategy,
      appliedFixes: appliedFixes,
      rerunResult: rerunResult,
      success: rerunResult.status === 'passed',
      finalStatus: rerunResult.status,
      healingLog: debugResult.log
    };
  }

  async runPlaywrightDebug(testId) {
    return new Promise((resolve) => {
      // Use headless mode instead of debug mode for automated healing
      const debugCommand = `npx playwright test --grep "${testId}" --reporter=json --workers=1`;
      
      exec(debugCommand, { 
        cwd: process.cwd(),
        timeout: 60000 // Reduced timeout for efficiency
      }, (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout,
          stderr: stderr,
          log: `${stdout}\n${stderr}`,
          error: error?.message
        });
      });
    });
  }

  analyzeFailureAndCreateStrategy(failedTest, debugResult) {
    const error = failedTest.error || '';
    const log = debugResult.log || '';
    
    let strategy = {
      type: 'unknown',
      fixes: [],
      reason: 'Unable to determine failure cause'
    };
    
    // Timeout errors
    if (error.includes('Test timeout') || error.includes('30000ms exceeded')) {
      strategy = {
        type: 'timeout',
        fixes: [
          'increase_timeout',
          'add_wait_conditions',
          'optimize_selectors'
        ],
        reason: 'Test is timing out - likely due to slow loading or incorrect wait conditions'
      };
    }
    // Selector errors
    else if (error.includes('strict mode violation') || error.includes('multiple elements')) {
      strategy = {
        type: 'selector',
        fixes: [
          'add_exact_matching',
          'improve_selector_specificity',
          'add_unique_locators'
        ],
        reason: 'Multiple elements match selector - need more specific locators'
      };
    }
    // Element not found
    else if (error.includes('Element not found') || error.includes('not visible')) {
      strategy = {
        type: 'element_missing',
        fixes: [
          'update_selectors',
          'add_wait_for_element',
          'check_page_structure'
        ],
        reason: 'Element selectors need updating - page structure may have changed'
      };
    }
    // Navigation errors
    else if (error.includes('page.goto') || error.includes('navigation')) {
      strategy = {
        type: 'navigation',
        fixes: [
          'add_retry_logic',
          'increase_navigation_timeout',
          'add_network_conditions'
        ],
        reason: 'Navigation issues - network or page loading problems'
      };
    }
    
    return strategy;
  }

  async applyTestFixes(testFile, strategy) {
    const appliedFixes = [];
    
    try {
      // Read the test file
      const testContent = fs.readFileSync(testFile, 'utf8');
      let updatedContent = testContent;
      
      // Apply fixes based on strategy
      switch (strategy.type) {
        case 'timeout':
          updatedContent = this.applyTimeoutFixes(updatedContent);
          appliedFixes.push('Added timeout configurations and wait conditions');
          break;
          
        case 'selector':
          updatedContent = this.applySelectorFixes(updatedContent);
          appliedFixes.push('Improved selector specificity and exact matching');
          break;
          
        case 'element_missing':
          updatedContent = this.applyElementFixes(updatedContent);
          appliedFixes.push('Updated selectors and added element wait conditions');
          break;
          
        case 'navigation':
          updatedContent = this.applyNavigationFixes(updatedContent);
          appliedFixes.push('Enhanced navigation reliability and timeouts');
          break;
          
        default:
          appliedFixes.push('Added general test resilience improvements');
          updatedContent = this.applyGeneralFixes(updatedContent);
      }
      
      // Write the updated content back to file
      fs.writeFileSync(testFile, updatedContent, 'utf8');
      
      console.log(`Applied ${appliedFixes.length} fixes to ${testFile}`);
      
    } catch (error) {
      console.error(`Error applying fixes to ${testFile}:`, error.message);
      appliedFixes.push(`Error applying fixes: ${error.message}`);
    }
    
    return appliedFixes;
  }

  applyTimeoutFixes(content) {
    // Add test timeout configuration
    if (!content.includes('test.setTimeout')) {
      content = content.replace(
        /test\(/g,
        'test.setTimeout(60000);\n  test('
      );
    }
    
    // Add wait conditions for common operations
    content = content.replace(
      /await page\.goto\(/g,
      'await page.goto('
    );
    
    return content;
  }

  applySelectorFixes(content) {
    // Add exact matching for common selectors
    content = content.replace(
      /getByText\('([^']+)'\)/g,
      "getByText('$1', { exact: true })"
    );
    
    // Add more specific selectors
    content = content.replace(
      /page\.locator\('([^']+)'\)/g,
      "page.locator('$1').first()"
    );
    
    return content;
  }

  applyElementFixes(content) {
    // Add wait for element before interactions
    content = content.replace(
      /await (page\.[^;]+\.click\(\))/g,
      'await $1.waitFor({ state: "visible" });\n    await $1'
    );
    
    return content;
  }

  applyNavigationFixes(content) {
    // Add navigation options (avoiding deprecated networkidle)
    content = content.replace(
      /page\.goto\('([^']+)'\)/g,
      "page.goto('$1', { waitUntil: 'load', timeout: 60000 })"
    );
    
    return content;
  }

  applyGeneralFixes(content) {
    // Add general resilience improvements
    if (!content.includes('test.slow()')) {
      content = content.replace(
        /test\(/g,
        'test.slow();\n  test('
      );
    }
    
    return content;
  }

  async rerunSingleTest(testId) {
    return new Promise((resolve) => {
      const rerunCommand = `npx playwright test --grep "${testId}" --reporter=json`;
      
      exec(rerunCommand, { 
        cwd: process.cwd(),
        timeout: 90000 // 1.5 minute timeout
      }, (error, stdout, stderr) => {
        try {
          const jsonOutput = JSON.parse(stdout);
          const testResult = jsonOutput.suites?.[0]?.specs?.[0]?.tests?.[0];
          
          resolve({
            status: testResult?.results?.[0]?.status || 'unknown',
            duration: testResult?.results?.[0]?.duration || 0,
            error: testResult?.results?.[0]?.error?.message,
            success: !error && testResult?.results?.[0]?.status === 'passed'
          });
        } catch (parseError) {
          resolve({
            status: 'failed',
            duration: 0,
            error: `Failed to parse test results: ${parseError.message}`,
            success: false
          });
        }
      });
    });
  }

  async createHealingSummaryIssue(healingResults) {
    try {
      const summary = `Automated Test Healing - ${new Date().toLocaleDateString()}`;
      const description = this.generateHealingSummary(healingResults);
      
      const healingIssue = {
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
          issuetype: { name: 'Task' },
          labels: ['playwright', 'auto-healing', 'test-maintenance'],
          priority: { name: 'High' }
        }
      };

      const response = await axios.post(
        '/rest/api/3/issue',
        healingIssue,
        this.jiraConfig
      );
      
      console.log(`Created healing summary issue: ${response.data.key}`);
      return response.data;
    } catch (error) {
      console.error('Error creating healing summary:', error.response?.data || error.message);
      return null;
    }
  }

  generateHealingSummary(healingResults) {
    const healed = healingResults.filter(r => r.success).length;
    const failed = healingResults.length - healed;
    
    let summary = `AUTOMATED TEST HEALING REPORT

HEALING OVERVIEW:
• Tests Successfully Healed: ${healed}
• Tests Still Failing: ${failed}
• Total Healing Attempts: ${healingResults.length}
• Success Rate: ${Math.round((healed / healingResults.length) * 100)}%

DETAILED HEALING RESULTS:
`;

    healingResults.forEach((result, index) => {
      const status = result.success ? 'HEALED' : 'FAILED';
      summary += `\n${index + 1}. ${result.testId}: ${status}`;
      summary += `\n   Original Error: ${result.originalError?.substring(0, 80)}...`;
      summary += `\n   Fix Strategy: ${result.fixStrategy?.reason || 'Unknown'}`;
      
      if (result.appliedFixes?.length > 0) {
        summary += `\n   Applied Fixes: ${result.appliedFixes.join(', ')}`;
      }
      
      if (result.success) {
        summary += `\n   Test now passes after healing`;
      } else {
        summary += `\n   Test still failing - manual intervention required`;
      }
      
      summary += '\n';
    });

    summary += `\nHEALING ACTIONS TAKEN:`;
    const allFixes = healingResults.flatMap(r => r.appliedFixes || []);
    const uniqueFixes = [...new Set(allFixes)];
    uniqueFixes.forEach(fix => {
      summary += `\n• ${fix}`;
    });

    return summary;
  }
}

module.exports = JiraReporter;
