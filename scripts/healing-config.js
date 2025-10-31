// healing-config.js
// Configuration for automated test healing

module.exports = {
  // Auto-healing settings
  autoHeal: {
    enabled: true,
    maxRetries: 3,
    debugTimeout: 120000, // 2 minutes
    rerunTimeout: 90000,   // 1.5 minutes
  },
  
  // Healing strategies configuration
  strategies: {
    timeout: {
      enabled: true,
      defaultTimeout: 60000,
      navigationTimeout: 60000,
      fixes: [
        'increase_test_timeout',
        'add_wait_conditions',
        'optimize_selectors',
        'add_retry_logic'
      ]
    },
    
    selector: {
      enabled: true,
      addExactMatching: true,
      addFirstSelector: true,
      fixes: [
        'add_exact_matching',
        'improve_specificity',
        'add_unique_locators',
        'use_data_testid'
      ]
    },
    
    element_missing: {
      enabled: true,
      addWaitConditions: true,
      fixes: [
        'update_selectors',
        'add_wait_for_element',
        'check_page_structure',
        'add_element_presence_check'
      ]
    },
    
    navigation: {
      enabled: true,
      addNetworkIdle: false, // Discouraged by Playwright
      fixes: [
        'add_retry_logic',
        'increase_navigation_timeout',
        'add_load_state_wait',
        'improve_error_handling'
      ]
    }
  },
  
  // Jira integration settings
  jira: {
    createHealingIssues: true,
    updateOriginalIssues: true,
    healingLabels: ['auto-healed', 'playwright-maintenance'],
    healingPriority: 'High'
  },
  
  // File backup settings
  backup: {
    enabled: true,
    backupDir: './test-backups',
    keepBackups: 5
  },
  
  // Logging settings
  logging: {
    verbose: true,
    logFile: './healing.log',
    logLevel: 'info' // debug, info, warn, error
  }
};
