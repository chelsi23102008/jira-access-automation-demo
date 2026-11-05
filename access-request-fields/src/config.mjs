// Existing Jira fields, not new fields. An unused duplicate Access Type exists,
// so retain these exact IDs for Jira Access Automation / Access Request.
export const config = Object.freeze({
  site: 'chelsiasworkspace-41902378.atlassian.net',
  projectId: '10000', projectKey: 'KAN', projectName: 'Jira Access Automation',
  issueTypeId: '10009', issueTypeName: 'Access Request',
  name: 'Access Request conditional fields — KAN',
  accessType: 'customfield_10052', accountId: 'customfield_10053',
  siteId: 'customfield_10054', role: 'customfield_10055', platform: 'customfield_10056'
});
export const branches = Object.freeze([
  { id: config.accountId, type: 'Account Access', empty: '' },
  { id: config.siteId, type: 'Account Access', empty: '' },
  { id: config.role, type: 'Role Access', empty: null },
  { id: config.platform, type: 'Platform Access', empty: null }
]);
export const registeredFields = [config.accessType, ...branches.map(field => field.id)];
