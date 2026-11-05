import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT, createBotClient } from '../src/bot.mjs';

test('credentials go only to the fixed Atlassian gateway with redirects blocked', async () => {
  const requests = [];
  const client = createBotClient({ token: 'test-token-only', fetch: async (url, options) => {
    requests.push({ url, options });
    return { status: 200, json: async () => ({ accountId: BOT.accountId, active: true }) };
  } });
  await client.verifyIdentity();
  assert.equal(requests[0].url, `https://api.atlassian.com/ex/jira/${BOT.cloudId}/rest/api/3/myself`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.headers.Authorization.startsWith('Basic '));
});

test('a missing token makes no network request', async () => {
  await assert.rejects(createBotClient({ fetch: () => assert.fail('No token, no request') }).verifyIdentity(), {
    code: 'BOT_TOKEN_MISSING'
  });
});

test('a token owned by another account cannot verify the bot identity', async () => {
  await assert.rejects(createBotClient({ token: 'test-token', fetch: async () => ({
    status: 200, json: async () => ({ accountId: 'some-other-account', active: true })
  }) }).verifyIdentity(), { code: 'BOT_IDENTITY_MISMATCH' });
});

for (const [status, code] of [[401, 'BOT_AUTH_FAILED'], [403, 'BOT_PERMISSION_DENIED'],
  [404, 'BOT_RECORD_NOT_FOUND'], [429, 'BOT_RATE_LIMITED']]) {
  test(`HTTP ${status} has a safe English error without reading its body`, async () => {
    await assert.rejects(createBotClient({ token: 'test-token', fetch: async () => ({
      status, json: () => assert.fail('Error body must not be read')
    }) }).verifyIdentity(), { code });
  });
}

test('invalid issue IDs cannot change the credential destination or API path', async () => {
  await assert.rejects(createBotClient({ token: 'test-token', fetch: () => assert.fail('Bad ID') })
    .postComment('../different-api', {}), { code: 'BOT_RESPONSE_INVALID' });
});

test('post requires a creation response from the pinned bot account', async () => {
  await assert.rejects(createBotClient({ token: 'test-token', fetch: async () => ({
    status: 201, json: async () => ({ id: '123', author: { accountId: 'other' } })
  }) }).postComment('12345', {}), { code: 'BOT_RESPONSE_INVALID' });
});

test('transport errors do not expose arbitrary SDK details', async () => {
  await assert.rejects(createBotClient({ token: 'test-token', fetch: async () => {
    throw new Error('private request details');
  } }).verifyIdentity(), { code: 'BOT_CONNECTION_FAILED' });
});

test('a transition sends the numeric transition ID and accepts 204 without parsing JSON', async () => {
  const requests = [];
  const client = createBotClient({ token: 'test-token', fetch: async (url, options) => {
    requests.push({ url, options });
    return { status: 204, json: () => assert.fail('A 204 response has no JSON body') };
  } });
  await client.transition('12345', '31');
  assert.ok(requests[0].url.endsWith('/issue/12345/transitions'));
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { transition: { id: '31' } });
});

test('status read-back must refer to the requested issue', async () => {
  const client = createBotClient({ token: 'test-token', fetch: async () => ({
    status: 200, json: async () => ({ id: '99999', fields: { status: { id: '10002', name: 'Done' } } })
  }) });
  await assert.rejects(client.getStatus('12345'), { code: 'BOT_RESPONSE_INVALID' });
});
