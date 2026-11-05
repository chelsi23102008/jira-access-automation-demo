import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRegistration } from '../src/registration.mjs';
import { config } from '../src/config.mjs';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function client(overrides = {}) {
  const writes = [];
  return {
    writes,
    getProject: async () => response({ id: config.projectId, key: config.projectKey, name: config.projectName }),
    getIssueType: async () => response({ id: config.issueTypeId, name: config.issueTypeName, scope: { project: { id: config.projectId } } }),
    list: async () => response({ isLast: true, values: [] }),
    create: async body => { writes.push({ method: 'POST', body }); return response({}, 201); },
    update: async (id, body) => { writes.push({ method: 'PUT', id, body }); return response({}, 204); },
    ...overrides
  };
}
test('registers exactly the intended project/type/Create context', async () => {
  const c = client();
  await ensureRegistration(c);
  assert.equal(c.writes.length, 1);
  assert.deepEqual(c.writes[0].body.contexts, [{ projectId: '10000', issueTypeId: '10009', viewType: 'GIC' }]);
});
test('refuses a different project before making any changes', async () => {
  const c = client({ getProject: async () => response({ id: '10000', key: 'OTHER', name: 'Another space' }) });
  await assert.rejects(ensureRegistration(c), /Target space/);
  assert.equal(c.writes.length, 0);
});
test('refuses a renamed or unrelated work type', async () => {
  const c = client({ getIssueType: async () => response({ id: '10009', name: 'Task' }) });
  await assert.rejects(ensureRegistration(c), /Target work type/);
  assert.equal(c.writes.length, 0);
});
test('finds an existing registration on a later page and updates instead of duplicating', async () => {
  const c = client({ list: async startAt => response(startAt === 0
    ? { startAt: 0, total: 2, values: [{ id: 'unrelated', name: 'Other behaviour' }] }
    : { isLast: true, values: [{ id: 'existing', name: config.name }] }) });
  await ensureRegistration(c);
  assert.equal(c.writes.length, 1);
  assert.equal(c.writes[0].method, 'PUT');
  assert.equal(c.writes[0].id, 'existing');
});
test('reports failed HTTP writes instead of claiming registration succeeded', async () => {
  await assert.rejects(ensureRegistration(client({ create: async () => response({}, 403) })), /HTTP 403/);
});
