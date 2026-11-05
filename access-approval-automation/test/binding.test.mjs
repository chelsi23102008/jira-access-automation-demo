import test from 'node:test';
import assert from 'node:assert/strict';
import { bindApproval, changedSinceApproval, fingerprint, isRelevantUpdate,
  readCompleteHistory, requestSnapshot, verifyBoundApproval } from '../src/binding.mjs';
import { createBindingStore } from '../src/binding-store.mjs';
import { checkRequestUpdate } from '../src/updates.mjs';
import { REQUEST_FIELDS as F } from '../src/request.mjs';
import { TARGET } from '../src/approval.mjs';

function fixture() {
  const user = { accountId: 'manager', active: true, accountType: 'atlassian' };
  const command = { issueId: '12345', issueKey: 'KAN-99', commentId: '67890', authorAccountId: 'manager' };
  const issue = { id: '12345', key: 'KAN-99', fields: {
    project: { id: TARGET.projectId }, issuetype: { id: TARGET.issueTypeId },labels: ['access-automation'],
    status: { statusCategory: { key: 'new' } }, reporter: { accountId: 'requester' },
    [TARGET.approverField]: [user], summary: 'Account access', description: null,
    updated: '2026-10-28T02:00:00.000Z', [F.category]: { value: 'Engineering' },
    [F.component]: { value: 'Databricks' }, [F.accessType]: { value: 'Account Access' },
    [F.accountId]: 'ACCOUNT-123', [F.siteId]: 'SITE-123'
  } };
  const comment = { id: '67890', body: 'Grant access', author: user, updateAuthor: user,
    created: '2026-10-28T02:00:00.000Z', updated: '2026-10-28T02:00:00.000Z' };
  const data = new Map();
  const storage = {
    async set(key, value, options) {
      if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) throw new Error('Conflict');
      data.set(key, structuredClone(value));
    },
    async get(key) { return structuredClone(data.get(key)); }
  };
  const bindings = createBindingStore(storage, prefix => prefix);
  const histories = [];
  const client = { getIssue: async () => structuredClone(issue), getComment: async () => structuredClone(comment),
    getHistory: async () => structuredClone(histories) };
  const now = () => '2026-10-28T02:00:01.000Z';
  return { command, issue, comment, storage, data, bindings, histories, client, now };
}
async function bind(f) { return bindApproval(f.command, structuredClone(f.issue), structuredClone(f.comment), f); }
async function verify(f) { return verifyBoundApproval(f.command.issueId, f.command.commentId, f); }

test('stable, valid request is bound, read back, and accepted by the freshness gate', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');
  assert.equal((await verify(f)).status, 'current');
  const record = await f.bindings.get('12345', '67890');
  assert.equal(record.snapshot.access.siteId, 'SITE-123');
  assert.equal(record.fingerprint, fingerprint(record.snapshot));
});

test('immutable binding cannot be overwritten with different request details', async () => {
  const f = fixture();
  await bind(f);
  const record = await f.bindings.get('12345', '67890');
  const changed = structuredClone(record);
  changed.snapshot.access.siteId = 'OTHER-SITE';
  changed.fingerprint = fingerprint(changed.snapshot);
  await assert.rejects(f.bindings.save(changed));
  assert.equal((await f.bindings.get('12345', '67890')).snapshot.access.siteId, 'SITE-123');
});

test('a relevant edit after the comment prevents initial binding of delayed approval events', async () => {
  const f = fixture();
  f.histories.push({ created: '2026-10-28T02:00:01.000Z', items: [{ fieldId: F.siteId }] });
  assert.equal((await bind(f)).status, 'stale');
  assert.equal(await f.bindings.get('12345', '67890'), undefined);
});

test('changing and restoring a field still invalidates the old approval permanently', async () => {
  const f = fixture();
  await bind(f);
  f.histories.push(
    { created: '2026-10-28T02:01:00.000Z', items: [{ fieldId: F.siteId }] },
    { created: '2026-10-28T02:02:00.000Z', items: [{ fieldId: F.siteId }] }
  );
  assert.equal((await verify(f)).status, 'stale');
  // Even if a future history read is incomplete, the permanent invalidation
  // record must prevent silently reactivating the old approval.
  f.histories.length = 0;
  assert.equal((await verify(f)).code, 'APPROVAL_ALREADY_INVALIDATED');
  const record = await f.bindings.get('12345', '67890');
  assert.equal(record.state, 'bound');
  assert.equal((await f.bindings.getInvalidation(record)).state, 'invalidated');
});

test('a fresh approval after an edit can bind a new snapshot', async () => {
  const f = fixture();
  await bind(f);
  f.issue.fields[F.siteId] = 'NEW-SITE';
  f.histories.push({ created: '2026-10-28T02:01:00.000Z', items: [{ fieldId: F.siteId }] });
  assert.equal((await verify(f)).status, 'stale');
  f.command.commentId = f.comment.id = '67891';
  f.comment.created = f.comment.updated = f.issue.fields.updated = '2026-10-28T02:02:00.000Z';
  assert.equal((await bind(f)).status, 'bound');
  assert.equal((await verify(f)).status, 'current');
});

for (const [type, field, before, after] of [
  ['Role Access', F.role, 'Read Only', 'Super User'],
  ['Platform Access', F.platform, 'Snowflake', 'AWS']
]) {
  test(`${type} approval cannot be reused for a different selection`, async () => {
    const f = fixture();
    f.issue.fields[F.accessType] = { value: type };
    f.issue.fields[field] = { value: before };
    assert.equal((await bind(f)).status, 'bound');
    f.issue.fields[field] = { value: after };
    assert.equal((await verify(f)).status, 'stale');
  });
}

test('any existing invalidation value fails closed instead of restoring approval', async () => {
  const f = fixture(); await bind(f);
  f.bindings.getInvalidation = async () => false;
  assert.equal((await verify(f)).code, 'APPROVAL_ALREADY_INVALIDATED');
});

for (const [name, mutate] of [
  ['reporter', f => { f.issue.fields.reporter.accountId = 'another-requester'; }],
  ['approver', f => { f.issue.fields[TARGET.approverField][0].accountId = 'another-manager'; }],
  ['account ID', f => { f.issue.fields[F.accountId] = 'OTHER-ACCOUNT'; }],
  ['summary', f => { f.issue.fields.summary = 'Different request'; }],
  ['description', f => { f.issue.fields.description = 'Changed justification'; }],
  ['category', f => { f.issue.fields[F.category].value = 'Other category'; }],
  ['component', f => { f.issue.fields[F.component].value = 'Other component'; }],
  ['access type', f => { f.issue.fields[F.accessType].value = 'Role Access'; f.issue.fields[F.role] = { value: 'Super User' }; }]
]) {
  test(`${name} changes cannot use the saved approval even if a change event was missed`, async () => {
    const f = fixture();
    await bind(f); mutate(f);
    assert.equal((await verify(f)).status, 'stale');
  });
}

for (const field of ['assignee', 'priority', F.role, F.platform]) {
  test(`irrelevant ${field} changes do not revoke an Account Access approval`, async () => {
    const f = fixture();
    await bind(f);
    f.issue.fields[field] = { value: 'Unrelated update' };
    f.issue.fields.updated = '2026-10-28T02:01:00.000Z';
    f.histories.push({ created: '2026-10-28T02:01:00.000Z', items: [{ fieldId: field }] });
    assert.equal((await verify(f)).status, 'current');
  });
}

test('an edit during the history check cannot produce a bound approval', async () => {
  const f = fixture();
  f.client.getHistory = async () => {
    f.issue.fields.updated = '2026-10-28T02:00:01.000Z';
    f.issue.fields[F.siteId] = 'CHANGED';
    return [];
  };
  assert.equal((await bind(f)).code, 'REQUEST_CHANGED_DURING_APPROVAL_CHECK');
});

test('an unrelated concurrent update is retried without cancelling approval', async () => {
  const f = fixture(); let reads = 0;
  f.client.getHistory = async () => {
    reads++; f.issue.fields.updated = '2026-10-28T02:00:01.000Z';
    return [{ created: '2026-10-28T02:00:01.000Z', items: [{ fieldId: 'assignee' }] }];
  };
  assert.equal((await bind(f)).status, 'bound');
  assert.equal(reads, 2);
});

test('an edited comment during verification cannot produce a bound approval', async () => {
  const f = fixture();
  f.client.getHistory = async () => { f.comment.updated = '2026-10-28T02:00:01.000Z'; return []; };
  assert.equal((await bind(f)).status, 'stale');
});

test('missing history, unreadable storage, or missing issue version fail closed', async () => {
  const f = fixture();
  f.client.getHistory = async () => { throw new Error('Private response'); };
  assert.equal((await bind(f)).status, 'manual-review');
  const g = fixture();
  g.bindings.save = async () => { throw new Error('Storage unavailable'); };
  assert.equal((await bind(g)).status, 'manual-review');
  const h = fixture(); delete h.issue.fields.updated;
  assert.equal((await bind(h)).status, 'manual-review');
});

test('legacy identity evidence alone cannot pass the freshness gate', async () => {
  assert.equal((await verify(fixture())).code, 'APPROVAL_BINDING_REQUIRED');
});

test('equal-timestamp edits require fresh approval; earlier edits are allowed', () => {
  const f = fixture(), snapshot = requestSnapshot(f.issue);
  const history = [{ created: f.comment.created, items: [{ field: 'Site ID' }] }];
  assert.equal(changedSinceApproval(history, f.comment.created, snapshot), true);
  history[0].created = '2026-10-28T01:59:59.999Z';
  assert.equal(changedSinceApproval(history, f.comment.created, snapshot), false);
});

test('JSON object-key order is irrelevant; description text is stored only as a hash', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  const f = fixture(); f.issue.fields.description = 'Private justification';
  assert.ok(!JSON.stringify(requestSnapshot(f.issue)).includes('Private justification'));
});

test('history reader includes later pages instead of trusting a truncated first page', async () => {
  const offsets = [];
  const result = await readCompleteHistory(async startAt => {
    offsets.push(startAt);
    return { startAt, total: 2, isLast: startAt === 1, values: [{ id: String(startAt) }] };
  });
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(result.length, 2);
});

test('incomplete or changing pagination is not accepted as complete history', async () => {
  await assert.rejects(readCompleteHistory(async startAt => ({ startAt, total: 2, isLast: true, values: [] })));
  await assert.rejects(readCompleteHistory(async startAt => ({ startAt, total: startAt ? 3 : 2,
    isLast: false, values: [{ id: '1' }] })));
});

test('relevant field edits invalidate and notify; ordinary assignee events are ignored', async () => {
  const f = fixture();
  await bind(f);
  const record = await f.bindings.get('12345', '67890');
  f.bindings.list = async () => [record];
  f.issue.fields[F.siteId] = 'CHANGED';
  f.histories.push({ created: '2026-10-28T02:01:00.000Z', items: [{ fieldId: F.siteId }] });
  const notices = [];
  const args = { ...f, notify: async (...values) => notices.push(values), log: () => {} };
  const event = { eventType: 'avi:jira:updated:issue', issue: { id: '12345' }, changelog: { items: [{ fieldId: F.siteId }] } };
  assert.equal((await checkRequestUpdate(event, args)).invalidated, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][2].status, 'stale');
  event.changelog.items = [{ fieldId: 'assignee' }];
  assert.equal((await checkRequestUpdate(event, args)).status, 'ignored');
});

test('a lagging notification query cannot make the authoritative freshness check pass', async () => {
  const f = fixture(); await bind(f);
  f.bindings.list = async () => [];
  f.issue.fields[F.siteId] = 'CHANGED';
  const event = { eventType: 'avi:jira:updated:issue', issue: { id: '12345' }, changelog: { items: [{ fieldId: F.siteId }] } };
  assert.equal((await checkRequestUpdate(event, { ...f, notify: () => assert.fail(), log: () => {} })).status, 'no-bound-approvals');
  assert.equal((await verify(f)).status, 'stale');
});

test('update metadata distinguishes unrelated edits and missing metadata', () => {
  assert.equal(isRelevantUpdate({ changelog: { items: [{ fieldId: 'assignee' }] } }), false);
  assert.equal(isRelevantUpdate({ changelog: { items: [{ field: 'Access Type' }] } }), true);
  assert.equal(isRelevantUpdate({}), true);
});

test('binding query traverses every page and checks issue ownership', async () => {
  const f = fixture(); await bind(f);
  const record = await f.bindings.get('12345', '67890');
  f.storage.query = () => {
    let cursor;
    const query = { where: () => query, limit: () => query,
      cursor: value => { cursor = value; return query; },
      getMany: async () => cursor ? { results: [{ value: record }] } : { results: [], nextCursor: 'next' } };
    return query;
  };
  assert.equal((await f.bindings.list('12345')).length, 1);
  await assert.rejects(f.bindings.list('99999'));
});
test('a request without the label cannot bind an approval', async () => {
  const f = fixture();
  f.issue.fields.labels = [];

  const result = await bind(f);

  assert.equal(result.status, 'stale');
  assert.equal(result.code, 'AUTOMATION_OPT_IN_REMOVED');
  assert.equal(await f.bindings.get('12345', '67890'), undefined);
});

test('removing the label invalidates an existing approval permanently', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  f.issue.fields.labels = [];

  assert.equal((await verify(f)).code, 'AUTOMATION_OPT_IN_REMOVED');

  // Once recorded as invalid, restoring the label cannot revive this approval.
  f.issue.fields.labels = ['access-automation'];

  assert.equal((await verify(f)).code, 'APPROVAL_ALREADY_INVALIDATED');
});

test('label removal during the history read prevents approval binding', async () => {
  const f = fixture();

  f.client.getHistory = async () => {
    f.issue.fields.labels = [];
    return [];
  };

  const result = await bind(f);

  assert.equal(result.status, 'stale');
  assert.equal(result.code, 'AUTOMATION_OPT_IN_REMOVED');
  assert.equal(await f.bindings.get('12345', '67890'), undefined);
});

test('adding an unrelated label does not invalidate approval', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  f.issue.fields.labels.push('urgent');
  f.issue.fields.updated = '2026-10-28T02:01:00.000Z';
  f.histories.push({
    created: '2026-10-28T02:01:00.000Z',
    items: [{
      fieldId: 'labels',
      fromString: 'access-automation',
      toString: 'access-automation urgent'
    }]
  });

  assert.equal((await verify(f)).status, 'current');
});
test('adding the label after an approval requires a new approval', async () => {
  const f = fixture();

  // The label exists now, but was added after the approval comment.
  f.histories.push({
    created: '2026-10-28T02:01:00.000Z',
    items: [{
      fieldId: 'labels',
      fromString: null,
      toString: 'access-automation'
    }]
  });

  assert.equal((await bind(f)).status, 'stale');
  assert.equal(await f.bindings.get('12345', '67890'), undefined);
});

test('removing and restoring the label requires fresh approval', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  // Both edits happened between checks. The label is present again now.
  f.histories.push(
    {
      created: '2026-10-28T02:01:00.000Z',
      items: [{
        fieldId: 'labels',
        fromString: 'access-automation',
        toString: null
      }]
    },
    {
      created: '2026-10-28T02:02:00.000Z',
      items: [{
        fieldId: 'labels',
        fromString: null,
        toString: 'access-automation'
      }]
    }
  );

  assert.equal((await verify(f)).status, 'stale');
  assert.equal((await verify(f)).code, 'APPROVAL_ALREADY_INVALIDATED');

  // A genuinely new approval, made after restoration, can proceed.
  f.command.commentId = f.comment.id = '67891';
  f.comment.created = f.comment.updated =
    f.issue.fields.updated = '2026-10-28T02:03:00.000Z';

  assert.equal((await bind(f)).status, 'bound');
  assert.equal((await verify(f)).status, 'current');
});

test('unreadable label history pauses approval for review', async () => {
  const f = fixture();

  f.histories.push({
    created: '2026-10-28T02:01:00.000Z',
    items: [{ fieldId: 'labels' }]
  });

  assert.equal((await bind(f)).status, 'manual-review');
  assert.equal(await f.bindings.get('12345', '67890'), undefined);
});

test('adding the label before the approval comment is allowed', async () => {
  const f = fixture();

  f.histories.push({
    created: '2026-10-28T01:59:00.000Z',
    items: [{
      fieldId: 'labels',
      fromString: null,
      toString: 'access-automation'
    }]
  });

  assert.equal((await bind(f)).status, 'bound');
  assert.equal((await verify(f)).status, 'current');
});