import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT, botError } from '../src/bot.mjs';
import { acknowledgeApproval, acknowledgementPayload, createNoticeStore } from '../src/notices.mjs';

const command = { issueId: '12345', issueKey: 'KAN-99', commentId: '67890' };

function fixture() {
  const data = new Map(), posted = [], logs = [];
  const issue = {
  id: '12345',
  fields: { labels: ['access-automation'] }
};

const client = {
  async getIssue() {
    return structuredClone(issue);
  }
};
  const storage = {
    async set(key, value, options) {
      if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) throw new Error('Conflict');
      data.set(key, structuredClone(value));
    },
    async get(key) { return structuredClone(data.get(key)); }
  };
  const bot = {
    async verifyIdentity() {},
    async postComment(issueId, payload) { posted.push({ issueId, payload }); return '88888'; },
    async getComment() { return { id: '88888', author: { accountId: BOT.accountId }, body: posted[0].payload.body }; }
  };
 return { data, posted, bot, issue, client,
  delivery: createNoticeStore(storage), logs,
    validation: { valid: true, code: 'REQUIRED_FIELDS_VALID', errorCodes: [] },
    binding: { status: 'bound', code: 'APPROVAL_BOUND_TO_REQUEST' },
    completion: { status: 'done', code: 'PHASE2_DONE_CONFIRMED', doneStatusId: '10002' },
    log: (...args) => logs.push(args) };
}

test('a verified bot posts confirmed Done text and records delivery', async () => {
  const context = fixture();
  const result = await acknowledgeApproval(command, {}, context);
  assert.equal(result.code, 'BOT_ACK_POSTED');
  assert.equal(context.posted.length, 1);
  assert.equal([...context.data.values()][0].state, 'posted');
  assert.ok(JSON.stringify(context.posted[0]).includes('This ticket is now Done'));
  assert.ok(!JSON.stringify(context.posted[0]).includes('Access granted'));
});

test('invalid request details produce a corrective bot reply, never a success claim', async () => {
  const context = fixture();
  context.validation = { valid: false, code: 'REQUEST_FIELDS_INVALID', errorCodes: ['SITE_ID_REQUIRED'] };
  delete context.completion;
  const result = await acknowledgeApproval(command, {}, context);
  assert.equal(result.code, 'BOT_ACK_POSTED');
  const text = JSON.stringify(context.posted[0]);
  assert.ok(text.includes('Enter the Site ID'));
  assert.ok(text.includes('ask the selected Approver to add a new Grant access comment'));
  assert.ok(!text.includes('fields passed validation'));
});

test('changed-request notices require fresh approval and use a separate delivery guard', async () => {
  const context = fixture();
  context.binding = { status: 'stale', code: 'APPROVED_DETAILS_CHANGED' };
  delete context.completion;
  const result = await acknowledgeApproval(command, {}, context);
  assert.equal(result.code, 'BOT_ACK_POSTED');
  assert.ok(JSON.stringify(context.posted[0]).includes('Changing the details back does not restore'));
  const other = createNoticeStore({
    set: async key => { assert.ok(key.startsWith('approval-change-notice:v1:')); }, get: async () => undefined
  }, 'approval-change-notice:v1');
  assert.equal(await other.claim(command, '2026-10-28T00:00:00Z'), 'claimed');
});

test('valid fields without a bound approval produce a review message', () => {
  const payload = acknowledgementPayload(command, {}, { valid: true, code: 'REQUIRED_FIELDS_VALID', errorCodes: [] });
  assert.ok(JSON.stringify(payload).includes('could not be tied to the reviewed request details'));
  assert.ok(!JSON.stringify(payload).includes('fields passed validation'));
});

test('concurrent deliveries cannot post two acknowledgements for one approval', async () => {
  const context = fixture();
  await Promise.all([acknowledgeApproval(command, {}, context), acknowledgeApproval(command, {}, context)]);
  assert.equal(context.posted.length, 1);
  assert.equal((await acknowledgeApproval(command, {}, context)).code, 'BOT_ACK_ALREADY_POSTED');
});

test('bot authentication failure happens before a delivery claim or comment', async () => {
  const context = fixture();
  context.bot.verifyIdentity = async () => { throw botError('BOT_AUTH_FAILED'); };
  assert.equal((await acknowledgeApproval(command, {}, context)).code, 'BOT_AUTH_FAILED');
  assert.equal(context.data.size, 0);
  assert.equal(context.posted.length, 0);
});

test('an uncertain POST is never automatically repeated on another event delivery', async () => {
  const context = fixture();
  let attempts = 0;
  context.bot.postComment = async () => { attempts++; throw botError('BOT_CONNECTION_FAILED'); };
  assert.equal((await acknowledgeApproval(command, {}, context)).code, 'BOT_CONNECTION_FAILED');
  assert.equal((await acknowledgeApproval(command, {}, context)).status, 'manual-review');
  assert.equal(attempts, 1);
});

test('an unconfirmed comment read cannot report a successful acknowledgement', async () => {
  const context = fixture();
  context.bot.getComment = async () => ({ id: '88888', author: { accountId: 'other' } });
  assert.equal((await acknowledgeApproval(command, {}, context)).status, 'manual-review');
  assert.equal([...context.data.values()][0].state, 'posting');
});

test('storage failure after a confirmed POST still prevents another POST', async () => {
  const context = fixture();
  context.delivery.complete = async () => { throw botError('NOTICE_STORAGE_FAILED'); };
  assert.equal((await acknowledgeApproval(command, {}, context)).code, 'NOTICE_STORAGE_FAILED');
  await acknowledgeApproval(command, {}, context);
  assert.equal(context.posted.length, 1);
});

test('restricted approval comments keep their visibility restrictions', async () => {
  const comment = { visibility: { type: 'role', identifier: '10002', value: 'Administrators' } };
  assert.deepEqual(acknowledgementPayload(command, comment).visibility, { type: 'role', identifier: '10002' });
  const context = fixture();
  assert.equal((await acknowledgeApproval(command, { visibility: { type: 'unexpected' } }, context)).status, 'manual-review');
  assert.equal(context.posted.length, 0);
});

test('failure logs contain a safe reason and never arbitrary exception text', async () => {
  const context = fixture();
  context.bot.verifyIdentity = async () => { throw new Error('private token detail'); };
  const result = await acknowledgeApproval(command, {}, context);
  assert.equal(result.status, 'manual-review');
  assert.ok(result.reason.length > 0);
  assert.ok(!JSON.stringify(context.logs).includes('private token detail'));
});
test('an unlabelled ticket receives no bot reply or delivery claim', async () => {
  const context = fixture();
  context.issue.fields.labels = [];

  context.bot.verifyIdentity = async () => {
    assert.fail('Bot authentication should not run');
  };

  const result = await acknowledgeApproval(command, {}, context);

  assert.equal(result.status, 'ignored');
  assert.equal(result.code, 'AUTOMATION_NOT_ENABLED');
  assert.equal(context.posted.length, 0);
  assert.equal(context.data.size, 0);
});

test('label removal between checks prevents the bot comment', async () => {
  const context = fixture();

  // Simulate removal after the first label check.
  context.bot.verifyIdentity = async () => {
    context.issue.fields.labels = [];
  };

  const result = await acknowledgeApproval(command, {}, context);

  assert.equal(result.status, 'ignored');
  assert.equal(result.code, 'AUTOMATION_NOT_ENABLED');
  assert.equal(context.posted.length, 0);

  // Keep the existing claim; do not automatically repeat this delivery.
  assert.equal([...context.data.values()][0].state, 'posting');
});

test('an unreadable ticket prevents comment delivery safely', async () => {
  const context = fixture();

  context.client.getIssue = async () => {
    throw new Error('Private Jira response detail');
  };

  const result = await acknowledgeApproval(command, {}, context);

  assert.equal(result.status, 'manual-review');
  assert.equal(context.posted.length, 0);
  assert.equal(context.data.size, 0);
  assert.ok(
    !JSON.stringify(context.logs).includes('Private Jira response detail')
  );
});