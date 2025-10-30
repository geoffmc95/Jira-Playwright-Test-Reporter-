## This repo includes two scripts, the Jira.reporter.JS, and the sync-traceability-to-jira.js ##

-<b> The purpose of the Jira.reporter.JS </b> script is to automatically send test results to Jira when they are run.

-<b> The purpose of the sync-traceability-to-jira.js </b> script is to be able to sync your traceability matrix created by a Playwright Agent directly to your Jira project. 

### Dependencies: ###
-Jira API token </br>
-Jira Project Key </br> 
-Jira Base URL (usally https://youraccountname.atlassian.et) </br>
-Everything within the 'Scripts' section of Package.json in this repo. 
-Everything within the 'reporter' section of playwright.config.json
```
npm init playwright@latest 
npx tsc --init 
npm install csv-parser axios dotenv 
npm install axios dotenv 
npm install --save-dev @types/node 
npm install --save-dev cross-env	 

```

### To initialize the Playwright Agent mode + MCP (not necessary unless you intend on using them) ###
```Npx playwright init-agents –loop vscode ```


### To run the Sync-traceability-to-jira.js script ###
```
npm run sync-to-jira-dry    # Shows "Dry run mode: ENABLED" 
npm run sync-to-jira        # Shows "Dry run mode: DISABLED" (actually creates issues)
npm run sync-to-jira-update # Shows "Dry run mode: DISABLED" (creates/updates issues)
```
