import api, { route } from '@forge/api';
import { config } from './config.mjs';
import { ensureRegistration } from './registration.mjs';

// Lifecycle events have no signed-in user. Register only this app's explicitly
// scoped UI behaviour using asApp; never provision access or modify tickets.
export async function run() {
  const jira = api.asApp();
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const client = {
    getProject: () => jira.requestJira(route`/rest/api/3/project/${config.projectId}`),
    getIssueType: () => jira.requestJira(route`/rest/api/3/issuetype/${config.issueTypeId}`),
    list: startAt => jira.requestJira(route`/rest/api/3/uiModifications?startAt=${startAt}&maxResults=100`),
    create: body => jira.requestJira(route`/rest/api/3/uiModifications`, {
      method: 'POST', headers, body: JSON.stringify(body)
    }),
    update: (id, body) => jira.requestJira(route`/rest/api/3/uiModifications/${id}`, {
      method: 'PUT', headers, body: JSON.stringify(body)
    })
  };
  // Propagate failures: log HTTP status codes without exposing request values.
  const result = await ensureRegistration(client);
  console.log(`Access Request conditional fields ${result.action}; KAN/10009/GIC.`);
}
