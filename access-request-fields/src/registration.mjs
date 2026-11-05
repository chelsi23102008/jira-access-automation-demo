import { config } from './config.mjs';

async function read(response, operation) {
  if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status}).`);
  return response.json();
}

export async function ensureRegistration(client) {
  // Verify that the configured IDs still identify the intended space/work type.
  // Never activate a wildcard project, type, or view context.
  const project = await read(await client.getProject(), 'Read target space');
  if (String(project.id) !== config.projectId || project.key !== config.projectKey ||
      project.name !== config.projectName) {
    throw new Error('Target space does not match Jira Access Automation. Registration stopped.');
  }
  const type = await read(await client.getIssueType(), 'Read target work type');
  if (String(type.id) !== config.issueTypeId || type.name !== config.issueTypeName ||
      (type.scope?.project?.id && String(type.scope.project.id) !== config.projectId)) {
    throw new Error('Target work type does not match Access Request. Registration stopped.');
  }
  // Repeated install/upgrade events reuse the registration, avoiding duplicates.
  let existing;
  let startAt = 0;
  while (true) {
    const page = await read(await client.list(startAt), 'List app UI modifications');
    existing = page.values?.find(item => item.name === config.name);
    if (existing || page.isLast || !page.values?.length) break;
    const next = (page.startAt ?? startAt) + page.values.length;
    if (next >= page.total) break;
    startAt = next;
  }
  const body = {
    name: config.name,
    description: 'Conditional access fields in global Create for KAN Access Request only.',
    contexts: [{ projectId: config.projectId, issueTypeId: config.issueTypeId, viewType: 'GIC' }]
  };
  const response = existing ? await client.update(existing.id, body) : await client.create(body);
  if (!response.ok) throw new Error(`Register conditional fields failed (HTTP ${response.status}).`);
  return { action: existing ? 'updated' : 'created' };
}
