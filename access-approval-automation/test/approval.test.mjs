import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET, detectApprovalCommand, verifyDesignatedApprover } from '../src/approval.mjs';
import { checkApproval, readJira } from '../src/process.mjs';
import { BOT } from '../src/bot.mjs';
import { REQUEST_FIELDS } from '../src/request.mjs';

function fixture(accountId = 'teammate-a') {
  const user = { accountId, active: true, accountType: 'atlassian' };
  return {
    eventType: 'avi:jira:commented:issue', atlassianId: accountId,
    issue: {
      id: '12345', key: 'KAN-99', fields: {
        project: { id: '10000' }, issuetype: { id: '10009' },
        labels: ['access-automation'],
        status: { statusCategory: { key: 'new' } },
        reporter: { accountId: 'requester' }, [TARGET.approverField]: [{ ...user }],
        summary: 'Sample account access request',
        updated: '2026-10-28T00:00:00.000Z', description: null,
        [REQUEST_FIELDS.category]: { value: 'Engineering' },
        [REQUEST_FIELDS.component]: { value: 'Databricks' },
        [REQUEST_FIELDS.accessType]: { value: 'Account Access' },
        [REQUEST_FIELDS.accountId]: 'SAMPLE-ACCOUNT', [REQUEST_FIELDS.siteId]: 'SAMPLE-SITE'
      }
    },
    comment: {
      id: '67890', body: 'Grant access', author: { ...user }, updateAuthor: { ...user },
      created: '2026-10-28T00:00:00.000Z', updated: '2026-10-28T00:00:00.000Z'
    }
  };
}
const adf = () => ({ type: 'doc', version: 1, content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Grant access' }] }
] });

const commandCases = [
  ['new plain-text command', () => {}, true],
  ['case and surrounding spaces', e => { e.comment.body = '  GRANT ACCESS  '; }, true],
  ['plain Jira ADF', e => { e.comment.body = adf(); }, true],
  ['ordinary comment', e => { e.comment.body = 'Please review this request'; }, false],
  ['extra words', e => { e.comment.body = 'Do not grant access'; }, false],
  ['different project', e => { e.issue.fields.project.id = '999'; }, false],
  ['different work type', e => { e.issue.fields.issuetype.id = '999'; }, false],
  ['edited comment', e => { e.comment.updated = '2026-10-28T00:01:00.000Z'; }, false],
  ['missing timestamp', e => { delete e.comment.created; }, false],
  ['invalid timestamp', e => { e.comment.created = e.comment.updated = 'invalid'; }, false],
  ['self-generated event', e => { e.selfGenerated = true; }, false],
  ['wrong event type', e => { e.eventType = 'avi:jira:created:issue'; }, false],
  ['missing author', e => { delete e.comment.author; }, false],
  ['actor mismatch', e => { e.atlassianId = 'another-user'; }, false],
  ['update author mismatch', e => { e.comment.updateAuthor.accountId = 'another-user'; }, false],
  ['invalid record ID', e => { e.comment.id = '../other'; }, false],
  ['quoted command', e => { e.comment.body = { type: 'doc', content: [{ type: 'blockquote', content: adf().content }] }; }, false],
  ['linked command', e => { e.comment.body = adf(); e.comment.body.content[0].content[0].marks = [{ type: 'link' }]; }, false],
  ['malformed ADF paragraph', e => { e.comment.body = { type: 'doc', content: [null] }; }, false],
  ['malformed ADF text node', e => { e.comment.body = { type: 'doc', content: [{ type: 'paragraph', content: [null] }] }; }, false]
];
for (const [name, mutate, expected] of commandCases) {
  test(`detection: ${name}`, () => {
    const event = fixture();
    mutate(event);
    assert.equal(Boolean(detectApprovalCommand(event)), expected);
  });
}
test('missing event is ignored', () => assert.equal(detectApprovalCommand(null), null));

test('the service account cannot approve even if it is selected as Approver', () => {
  const event = fixture(BOT.accountId);
  assert.equal(verifyDesignatedApprover(detectApprovalCommand(event), event.issue, event.comment).code,
    'SERVICE_ACCOUNT_CANNOT_APPROVE');
});

for (const accountId of ['teammate-a', 'another-workspace-teammate']) {
  test(`accepts the selected teammate without a personal allowlist: ${accountId}`, () => {
    const event = fixture(accountId);
    assert.deepEqual(verifyDesignatedApprover(detectApprovalCommand(event), event.issue, event.comment), {
      matched: true, code: 'DESIGNATED_APPROVER_MATCHED'
    });
  });
}

const identityCases = [
  ['single user object', e => { e.issue.fields[TARGET.approverField] = e.issue.fields[TARGET.approverField][0]; }, 'DESIGNATED_APPROVER_MATCHED'],
  ['different selected approver', e => { e.issue.fields[TARGET.approverField][0].accountId = 'different-manager'; }, 'NOT_DESIGNATED_APPROVER'],
  ['self-approval', e => { e.issue.fields.reporter.accountId = e.comment.author.accountId; }, 'SELF_APPROVAL'],
  ['missing reporter', e => { e.issue.fields.reporter = null; }, 'REPORTER_REQUIRED'],
  ['missing approver', e => { e.issue.fields[TARGET.approverField] = null; }, 'SINGLE_APPROVER_REQUIRED'],
  ['multiple approvers', e => { e.issue.fields[TARGET.approverField].push({ accountId: 'other' }); }, 'SINGLE_APPROVER_REQUIRED'],
  ['inactive approver', e => { e.issue.fields[TARGET.approverField][0].active = false; }, 'INACTIVE_APPROVER'],
  ['inactive author', e => { e.comment.author.active = false; }, 'INACTIVE_APPROVER'],
  ['app account', e => { e.comment.author.accountType = 'app'; }, 'APP_CANNOT_APPROVE'],
  ['already completed request', e => { e.issue.fields.status.statusCategory.key = 'done'; }, 'REQUEST_ALREADY_DONE'],
  ['comment edited after event', e => { e.comment.updated = '2026-10-28T01:00:00.000Z'; }, 'COMMENT_OR_REQUEST_CHANGED'],
  ['comment author changed', e => { e.comment.author.accountId = 'other'; }, 'COMMENT_OR_REQUEST_CHANGED'],
  ['project changed after event', e => { e.issue.fields.project.id = '999'; }, 'COMMENT_OR_REQUEST_CHANGED'],
  ['different issue record', e => { e.issue.id = '999'; }, 'RECORD_MISMATCH'],
  ['different comment record', e => { e.comment.id = '999'; }, 'RECORD_MISMATCH']
];
for (const [name, mutate, code] of identityCases) {
  test(`current Jira records: ${name}`, () => {
    const event = fixture();
    const command = detectApprovalCommand(event);
    mutate(event);
    const result = verifyDesignatedApprover(command, event.issue, event.comment);
    assert.equal(result.code, code);
    assert.equal(result.matched, code === 'DESIGNATED_APPROVER_MATCHED');
  });
}

test('ordinary comments make no Jira calls', async () => {
  const event = fixture();
  event.comment.body = 'A normal discussion';
  const client = {
    getIssue: () => assert.fail('Unexpected Jira read'),
    getComment: () => assert.fail('Unexpected Jira read')
  };
  assert.deepEqual(await checkApproval(event, { client }), { status: 'ignored' });
});

test('reads current Jira records and logs only safe identifiers', async () => {
  const event = fixture();
  const calls = [], logs = [];
  const client = {
    async getIssue(id) { calls.push(['issue', id]); return event.issue; },
    async getComment(id, comment) { calls.push(['comment', id, comment]); return event.comment; },
    async getHistory(id) { calls.push(['history', id]); return []; }
  };
  const records = [];
  const result = await checkApproval(event, {
    client, store: { save: async record => { records.push(record); return 'saved'; } },
    bindings: { getInvalidation: async () => undefined, save: async () => {} },
    log: (...args) => logs.push(args)
  });
  assert.equal(result.status, 'approval-recorded');
  assert.deepEqual(calls, [['issue', '12345'], ['comment', '12345', '67890'],
    ['history', '12345'], ['issue', '12345'], ['comment', '12345', '67890']]);
  assert.equal(logs.length, 4);
  assert.equal(JSON.parse(logs[0][1]).code, 'DESIGNATED_APPROVER_MATCHED');
  assert.equal(JSON.parse(logs[1][1]).code, 'APPROVER_IDENTITY_RECORDED');
  assert.equal(JSON.parse(logs[2][1]).code, 'REQUIRED_FIELDS_VALID');
  assert.equal(JSON.parse(logs[3][1]).code, 'APPROVAL_BOUND_TO_REQUEST');
  assert.equal(records[0].approverAccountId, 'teammate-a');
  assert.ok(!JSON.stringify(logs).includes('teammate-a'));
  assert.ok(!JSON.stringify(logs).includes('Grant access'));
});

test('uses the current selected approver instead of the event snapshot', async () => {
  const event = fixture();
  const currentIssue = structuredClone(event.issue);
  currentIssue.fields[TARGET.approverField][0].accountId = 'new-manager';
  const result = await checkApproval(event, {
    client: { getIssue: async () => currentIssue, getComment: async () => event.comment }, log: () => {}
  });
  assert.equal(result.status, 'approval-rejected');
  assert.equal(result.code, 'NOT_DESIGNATED_APPROVER');
});

test('a rejected identity is never saved', async () => {
  const event = fixture();
  event.issue.fields.reporter.accountId = event.comment.author.accountId;
  const result = await checkApproval(event, {
    client: { getIssue: async () => event.issue, getComment: async () => event.comment },
    store: { save: () => assert.fail('Self-approval must not be persisted') }, log: () => {},
    acknowledge: () => assert.fail('Self-approval must not receive a bot acknowledgement')
  });
  assert.equal(result.code, 'SELF_APPROVAL');
});

test('persistence errors produce a failure log, not a recorded approval', async () => {
  const event = fixture(), logs = [];
  await assert.rejects(checkApproval(event, {
    client: { getIssue: async () => event.issue, getComment: async () => event.comment },
    store: { save: async () => { throw new Error('Private SDK detail'); } },
    log: (...args) => logs.push(args),
    acknowledge: () => assert.fail('Unrecorded approval must not receive a bot acknowledgement')
  }), { message: 'APPROVAL_RECORD_FAILED' });
  assert.equal(JSON.parse(logs[1][1]).status, 'record-failed');
  assert.ok(!JSON.stringify(logs).includes('Private SDK detail'));
});

test('acknowledgement runs only after the verified identity was saved', async () => {
  const event = fixture(), sequence = [];
  const result = await checkApproval(event, {
    client: { getIssue: async () => event.issue, getComment: async () => event.comment },
    store: { save: async () => { sequence.push('saved'); return 'saved'; } },
    acknowledge: async () => { sequence.push('acknowledged'); return { status: 'posted' }; },
    log: () => {}
  });
  assert.deepEqual(sequence, ['saved', 'acknowledged']);
  assert.equal(result.acknowledgement.status, 'posted');
});

test('validation uses current request details and passes missing fields to the bot reply', async () => {
  const event = fixture(), logs = [], checks = [];
  const current = structuredClone(event.issue);
  current.fields[REQUEST_FIELDS.siteId] = null;
  const result = await checkApproval(event, {
    client: { getIssue: async () => current, getComment: async () => event.comment },
    store: { save: async () => 'saved' },
    acknowledge: async (_command, _comment, validation) => { checks.push(validation); return { status: 'posted' }; },
    log: (...args) => logs.push(args)
  });
  assert.equal(result.validation.valid, false);
  assert.deepEqual(checks[0].errorCodes, ['SITE_ID_REQUIRED']);
  assert.equal(JSON.parse(logs[2][1]).code, 'REQUEST_FIELDS_INVALID');
  assert.ok(!JSON.stringify(logs).includes('SAMPLE-ACCOUNT'));
  assert.ok(!JSON.stringify(logs).includes('Databricks'));
});

test('duplicate delivery is reported as already recorded', async () => {
  const event = fixture();
  const result = await checkApproval(event, {
    client: { getIssue: async () => event.issue, getComment: async () => event.comment },
    store: { save: async () => 'already-recorded' }, log: () => {}
  });
  assert.equal(result.status, 'approval-already-recorded');
});

test('a failed Jira read cannot produce a successful identity check', async () => {
  const event = fixture();
  await assert.rejects(checkApproval(event, {
    client: { getIssue: async () => { throw new Error('Read failed'); }, getComment: async () => event.comment },
    log: () => assert.fail('No success/rejection log is valid when reads fail')
  }), /Read failed/);
});

test('Jira HTTP errors do not read or expose arbitrary response bodies', async () => {
  await assert.rejects(readJira({
    ok: false, status: 403, json: () => assert.fail('Error body must not be read')
  }, 'Read approval comment'), { message: 'Read approval comment failed (HTTP 403).' });
});

test('successful Jira responses are parsed', async () => {
  assert.deepEqual(await readJira({ ok: true, json: async () => ({ id: '12345' }) }, 'Read request'), { id: '12345' });
});
test('a currently unlabelled ticket stops before further processing', async () => {
  const event = fixture();

  // The old event has the label, but the current ticket does not.
  const currentIssue = structuredClone(event.issue);
  currentIssue.fields.labels = [];

  const unexpected = () => assert.fail(
    'An unlabelled ticket must not continue processing'
  );

  const result = await checkApproval(event, {
    client: {
      getIssue: async () => currentIssue,
      getComment: unexpected
    },
    store: { save: unexpected },
    complete: unexpected,
    acknowledge: unexpected,
    reject: unexpected,
    log: unexpected
  });

  assert.deepEqual(result, { status: 'ignored' });
});

test('having the label does not bypass the selected approver check', async () => {
  const event = fixture();

  // The commenter differs from the currently selected Approver.
  event.issue.fields[TARGET.approverField][0].accountId = 'another-manager';

  const result = await checkApproval(event, {
    client: {
      getIssue: async () => event.issue,
      getComment: async () => event.comment
    },
    log: () => {}
  });

  assert.equal(result.status, 'approval-rejected');
  assert.equal(result.code, 'NOT_DESIGNATED_APPROVER');
});