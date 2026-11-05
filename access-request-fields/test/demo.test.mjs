import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidate, eligible, requestSnapshot, validationFailure, isApproval } from '../src/demo/policy.mjs';
import { config } from '../src/config.mjs';
import { processApproval } from '../src/demo/process.mjs';
import { simulateGrant } from '../src/demo/simulate.mjs';
import { createClient, SERVICE_EMAIL } from '../src/demo/client.mjs';

const copy = value => structuredClone(value);
const options = { enabled: true, serviceAccountId: 'bot', approverIds: ['manager'] };
const job = { issueId: '12345', commentId: '111', actorId: 'manager' };
const approvedAt = '2026-10-27T11:00:00.000Z';
function fixture() {
  const issue = { id: '12345', key: 'KAN-TEST', fields: {
    project: { id: '10000' }, issuetype: { id: '10009' },
    reporter: { accountId: 'requester', displayName: 'Demo Requester' },
    customfield_10057: [{ accountId: 'manager' }],
    customfield_10058: { value: 'Cloud' }, customfield_10059: { value: 'Databricks' },
    [config.accessType]: { value: 'Account Access' },
    [config.accountId]: 'DEMO-ACCOUNT', [config.siteId]: 'DEMO-SITE',
    [config.role]: null, [config.platform]: null,
    labels: ['access-automation-demo'], status: { name: 'To Do', statusCategory: { key: 'new' } }
  } };
  const comment = { id: '111', author: { accountId: 'manager' }, updateAuthor: { accountId: 'manager' },
    body: 'Grant access', created: approvedAt, updated: approvedAt };
  const comments = [];
  const calls = [];
  const records = new Map();
  const store = { get: async k => copy(records.get(k)), set: async (k, v) => records.set(k, copy(v)) };
  const client = {
    identity: async () => ({ accountId: 'bot' }), permissions: async () => {},
    getIssue: async () => copy(issue), getComment: async () => copy(comment), history: async () => [],
    closedTransition: async () => '41',
    findComment: async (_, marker, author) => comments.find(c => c.author.accountId === author && c.text.split('\n').includes(marker)),
    addComment: async (_, text) => {
      calls.push('comment'); const c = { id: String(comments.length + 100), author: { accountId: 'bot' }, text };
      comments.push(c); return copy(c);
    },
    close: async () => { calls.push('close'); issue.fields.status = { name: 'Closed', statusCategory: { key: 'done' } }; }
  };
  let grants = 0;
  const grant = request => { calls.push('grant'); grants++; return simulateGrant(request); };
  return { issue, comment, client, store, calls, records, comments,
    deps: { options, client, store, grant }, grants: () => grants };
}

for (const body of ['do not grant access', 'Grant access please', 'Access granted',
  { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'text', text: 'Grant access' }] }] },
  { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Grant access', marks: [{ type: 'link' }] }] }] }]) {
  test(`only the explicit approval command is accepted: ${JSON.stringify(body)}`, () => assert.equal(isApproval(body), false));
}
test('plain Jira rich-text paragraph and case-insensitive command are accepted', () => {
  assert.equal(isApproval({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Grant access' }] }] }), true);
  assert.equal(isApproval('  GRANT ACCESS  '), true);
});
test('comment events ignore edits, spoofed actors, bot output and disabled mode', () => {
  const f = fixture();
  const event = { eventType: 'avi:jira:commented:issue', issue: f.issue, comment: f.comment, atlassianId: 'manager' };
  assert.deepEqual(candidate(event, options), job);
  assert.equal(candidate(event, { ...options, enabled: false }), null);
  assert.equal(candidate({ ...event, selfGenerated: true }, options), null);
  assert.equal(candidate({ ...event, atlassianId: 'someone-else' }, options), null);
  assert.equal(candidate({ ...event, comment: { ...f.comment, updated: '2026-10-27T12:00:00Z' } }, options), null);
});
for (const mutate of [
  f => { f.issue.fields.customfield_10057 = [{ accountId: 'another-manager' }]; },
  f => { f.issue.fields.reporter.accountId = 'manager'; },
  f => { f.comment.author.accountId = 'someone-else'; },
  f => { f.issue.fields.labels = []; },
  f => { f.issue.fields.project.id = 'another-project'; },
  f => { f.issue.fields.issuetype.id = 'another-type'; },//what is another type
  f => { f.comment.updated = '2026-10-27T12:00:00Z'; }//why specifcially mentioned
]) {
  test(`rejects unauthorized approval: ${mutate.toString()}`, async () => {
    const f = fixture(); mutate(f);
    await processApproval(job, f.deps);
    assert.equal(f.grants(), 0);
    assert.equal(f.comments.length, 0);
    assert.equal(f.calls.includes('close'), false);
  });
}
test('success posts a labelled simulation result before closing, once only', async () => {
  const f = fixture();
  assert.equal((await processApproval(job, f.deps)).status, 'closed');
  assert.deepEqual(f.calls, ['grant', 'comment', 'close']);
  assert.match(f.comments[0].text, /DEMO.*No real access was changed/);
  assert.equal((await processApproval(job, f.deps)).status, 'duplicate');
  assert.equal((await processApproval({ ...job, commentId: '222' }, f.deps)).status, 'already-processed');
  assert.equal(f.grants(), 1);
});
for (const scenario of ['account-not-found', 'permission', 'unavailable']) {
  test(`simulated ${scenario} failure posts English reason and keeps ticket open`, async () => {
    const f = fixture(); f.issue.fields.labels.push(`demo-fail-${scenario}`);
    const result = await processApproval(job, f.deps);
    assert.equal(result.status, 'failed');
    assert.equal(f.calls.includes('close'), false);
    assert.match(f.comments[0].text, /Failed to grant access in the demo/);
    assert.match(f.comments[0].text, /The ticket remains open/);
    assert.equal(f.issue.fields.status.name, 'To Do');
  });
}
test('changed request details invalidate an earlier approval', async () => {
  const f = fixture();
  f.client.history = async () => [{ created: '2026-10-27T12:00:00Z', items: [{ fieldId: config.accountId }] }];
  await processApproval(job, f.deps);
  assert.equal(f.grants(), 0);
  assert.match(f.comments[0].text, /request details changed after approval/);
});
test('missing Closed transition fails clearly without simulating a grant', async () => {
  const f = fixture(); f.client.closedTransition = async () => null;
  await processApproval(job, f.deps);
  assert.equal(f.grants(), 0);
  assert.match(f.comments[0].text, /no available transition to Closed/);
});
test('invalid field combinations are rejected on the backend', async () => {
  const f = fixture(); f.issue.fields[config.role] = { value: 'Super User' };
  await processApproval(job, f.deps);
  assert.equal(f.grants(), 0);
  assert.match(f.comments[0].text, /unrelated fields/);
});
test('selected roles and platforms are checked against the supported values', () => {
  const f = fixture(); const s = requestSnapshot(f.issue);
  assert.match(validationFailure({ ...s, accessType: 'Role Access', role: 'Administrator', accountId: '', siteId: '' }), /Select Team Member/);
  assert.match(validationFailure({ ...s, accessType: 'Platform Access', platform: 'Anything', accountId: '', siteId: '' }), /Select EC2/);
});
test('a Jira comment timeout is reconciled without a duplicate result or repeat grant', async () => {
  const f = fixture(); const original = f.client.addComment;
  let first = true;
  f.client.addComment = async (...args) => {
    const result = await original(...args);
    if (first) { first = false; throw new Error('Simulated lost response'); }
    return result;
  };
  await assert.rejects(processApproval(job, f.deps), /lost response/);
  assert.equal((await processApproval(job, f.deps)).status, 'closed');
  assert.equal(f.grants(), 1);
  assert.equal(f.comments.length, 1);
});
test('a closure timeout retries only Jira closure, not the grant', async () => {
  const f = fixture(); const original = f.client.close;
  let first = true;
  f.client.close = async (...args) => { if (first) { first = false; throw new Error('Temporary network failure'); } return original(...args); };
  await assert.rejects(processApproval(job, f.deps), /network failure/);
  await processApproval(job, f.deps);
  assert.equal(f.grants(), 1); assert.equal(f.comments.length, 1);
});
test('closing succeeded but its response was lost: retry discovers Closed', async () => {
  const f = fixture(); const original = f.client.close;
  f.client.close = async (...args) => { await original(...args); throw new Error('Lost response'); };
  await assert.rejects(processApproval(job, f.deps), /Lost response/);
  assert.equal((await processApproval(job, f.deps)).status, 'closed');
  assert.equal(f.grants(), 1); assert.equal(f.calls.filter(v => v === 'close').length, 1);
});
test('closure permission failure reports the real Jira update problem separately', async () => {
  const f = fixture(); f.client.close = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  assert.equal((await processApproval(job, f.deps)).status, 'manual-review');
  assert.equal(f.comments.length, 2);
  assert.match(f.comments[1].text, /does not have permission to close/);
  assert.equal(f.issue.fields.status.name, 'To Do');
});
test('request change during processing prevents closure of the altered request', async () => {
  const f = fixture(); let reads = 0;
  f.client.getIssue = async () => { if (++reads === 2) f.issue.fields.reporter.accountId = 'new-requester'; return copy(f.issue); };
  assert.equal((await processApproval(job, f.deps)).status, 'manual-review');
  assert.equal(f.calls.includes('close'), false);
  assert.match(f.comments[1].text, /details changed during processing/);
});
test('Jira transport uses the service-account gateway and never leaks tokens in errors', async () => {
  const secret = 'test-token-never-log'; const calls = [];
  const client = createClient(async (url, options) => {
    calls.push({ url, options }); return { ok: false, status: 403 };
  }, secret);
  await assert.rejects(client.identity(), e => /HTTP 403/.test(e.message) && !e.message.includes(secret));
  assert.match(calls[0].url, /^https:\/\/api.atlassian.com\/ex\/jira\//);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
});
test('a token for an unintended account cannot become the comment author', async () => {
  const client = createClient(async () => ({ ok: true, status: 200, json: async () => ({ accountId: 'wrong', emailAddress: 'someone@example.com' }) }), 'test');
  await assert.rejects(client.identity(), /expected AccessAutomationBot/);
});
test('the intended service account identity is accepted', async () => {
  const client = createClient(async () => ({ ok: true, status: 200, json: async () => ({ accountId: 'bot', emailAddress: SERVICE_EMAIL }) }), 'test');
  assert.equal((await client.identity()).accountId, 'bot');
});
