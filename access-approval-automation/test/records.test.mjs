import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalStore, identityRecord } from '../src/records.mjs';

const record = () => identityRecord(
  { issueId: '12345', commentId: '67890', authorAccountId: 'manager' },
  { key: 'KAN-99', fields: { reporter: { accountId: 'requester' } } },
  { created: '2026-10-28T00:00:00.000Z' }, '2026-10-28T00:00:01.000Z'
);

// Model the server's documented atomic conditional write. The test verifies
// that our adapter uses that guarantee, rather than a JS get-then-set sequence.
function memoryStorage() {
  const data = new Map();
  return {
    data,
    async set(key, value, options) {
      assert.deepEqual(options, { keyPolicy: 'FAIL_IF_EXISTS' });
      if (data.has(key)) throw new Error('Key already exists');
      data.set(key, structuredClone(value));
    },
    async get(key) { return structuredClone(data.get(key)); }
  };
}

test('concurrent deliveries keep a single immutable record', async () => {
  const storage = memoryStorage(), store = createApprovalStore(storage);
  const original = record();
  const retry = { ...original, verifiedAt: '2026-10-28T00:00:02.000Z' };
  assert.deepEqual(await Promise.all([store.save(original), store.save(retry)]), ['saved', 'already-recorded']);
  assert.equal(storage.data.size, 1);
  assert.deepEqual([...storage.data.values()][0], original);
});

test('a separate new comment gets a separate record', async () => {
  const storage = memoryStorage(), store = createApprovalStore(storage);
  await store.save(record());
  assert.equal(await store.save({ ...record(), commentId: '67891' }), 'saved');
  assert.equal(storage.data.size, 2);
});

test('different identities cannot overwrite an existing approval record', async () => {
  const storage = memoryStorage(), store = createApprovalStore(storage);
  await store.save(record());
  await assert.rejects(store.save({ ...record(), approverAccountId: 'other-person' }), {
    code: 'APPROVAL_RECORD_CONFLICT'
  });
  assert.equal([...storage.data.values()][0].approverAccountId, 'manager');
});

test('a lost write response can be recovered only by reading the saved record', async () => {
  const storage = memoryStorage();
  const set = storage.set.bind(storage);
  storage.set = async (...args) => { await set(...args); throw new Error('Connection lost'); };
  assert.equal(await createApprovalStore(storage).save(record()), 'already-recorded');
});

test('a failed write with no stored record is not treated as a duplicate', async () => {
  await assert.rejects(createApprovalStore({
    set: async () => { throw new Error('Rate limit'); }, get: async () => undefined
  }).save(record()), { code: 'APPROVAL_STORAGE_UNAVAILABLE' });
});

test('a failed read cannot confirm that persistence succeeded', async () => {
  await assert.rejects(createApprovalStore({
    set: async () => {}, get: async () => { throw new Error('Private storage details'); }
  }).save(record()), { code: 'APPROVAL_STORAGE_UNAVAILABLE' });
});

test('successful writes still require a matching read-back', async () => {
  await assert.rejects(createApprovalStore({
    set: async () => {}, get: async () => undefined
  }).save(record()), { code: 'APPROVAL_RECORD_NOT_CONFIRMED' });
});

test('records contain identity evidence without comment text or access-granted state', () => {
  const saved = record();
  assert.equal(saved.state, 'approver_identity_verified');
  assert.equal(saved.commentCreatedAt, '2026-10-28T00:00:00.000Z');
  assert.ok(!JSON.stringify(saved).includes('Grant access'));
  assert.ok(!Object.hasOwn(saved, 'accessGranted'));
});
