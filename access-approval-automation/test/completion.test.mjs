import test from 'node:test';
import assert from 'node:assert/strict';
import { completePhase2, createCompletionStore, selectDoneTransition } from '../src/completion.mjs';
import { bindApproval } from '../src/binding.mjs';
import { createBindingStore } from '../src/binding-store.mjs';
import { createApprovalStore } from '../src/records.mjs';
import { checkApproval } from '../src/process.mjs';
import { acknowledgeApproval, acknowledgementPayload, createNoticeStore } from '../src/notices.mjs';
import { checkRequestUpdate } from '../src/updates.mjs';
import { TARGET } from '../src/approval.mjs';
import { BOT, botError } from '../src/bot.mjs';
import { REQUEST_FIELDS as F } from '../src/request.mjs';

const done = { id: '10002', name: 'Done', statusCategory: { key: 'done' } };
const closed = { id: '10003', name: 'Closed', statusCategory: { key: 'done' } };
const choices = [{ id: '41', name: 'Close', to: closed }, { id: '31', name: 'Finish', to: done }];

function fixture(approverId = 'a-different-workspace-teammate') {
  const user = { accountId: approverId, active: true, accountType: 'atlassian' };
  const command = { issueId: '12345', issueKey: 'KAN-99', commentId: '67890', authorAccountId: approverId };
  const issue = { id: command.issueId, key: command.issueKey, fields: {
    project: { id: TARGET.projectId }, issuetype: { id: TARGET.issueTypeId },
    labels: ['access-automation'],
    status: { id: '10000', name: 'To Do', statusCategory: { key: 'new' } },
    reporter: { accountId: 'requester' }, [TARGET.approverField]: [user],
    summary: 'Account access', description: null, updated: '2026-10-28T02:00:00.000Z',
    [F.category]: { value: 'Engineering' }, [F.component]: { value: 'Databricks' },
    [F.accessType]: { value: 'Account Access' }, [F.accountId]: 'ACCOUNT', [F.siteId]: 'SITE'
  } };
  const comment = { id: command.commentId, body: 'Grant access', author: user, updateAuthor: user,
    created: '2026-10-28T02:00:00.000Z', updated: '2026-10-28T02:00:00.000Z' };
  const event = { eventType: 'avi:jira:commented:issue', atlassianId: approverId, issue, comment };
  const data = new Map(), posted = [], transitions = [], logs = [], histories = [];
  const storage = {
    async set(key, value, options) {
      if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) throw new Error('Conflict');
      data.set(key, structuredClone(value));
    },
    async get(key) { return structuredClone(data.get(key)); }
  };
  const client = { getIssue: async () => structuredClone(issue), getComment: async () => structuredClone(comment),
    getHistory: async () => structuredClone(histories) };
  const bot = {
    async verifyIdentity() {},
    async getTransitions() { return structuredClone(choices); },
    async transition(issueId, transitionId) {
      transitions.push({ issueId, transitionId });
      issue.fields.status = structuredClone(done);
      issue.fields.updated = '2026-10-28T02:00:02.000Z';
      histories.push({ created: issue.fields.updated, items: [{ fieldId: 'status' }] });
    },
    async getStatus() { return structuredClone(issue.fields.status); },
    async postComment(issueId, payload) { posted.push({ issueId, payload }); return '88888'; },
    async getComment() { return { id: '88888', author: { accountId: BOT.accountId }, body: posted.at(-1).payload.body }; }
  };
  const bindings = createBindingStore(storage, prefix => prefix);
  const f = { command, issue, comment, event, data, storage, client, bot, bindings, posted, transitions, histories,
    completionStore: createCompletionStore(storage), now: () => '2026-10-28T02:00:01.000Z',
    log: (...args) => logs.push(args), logs };
  f.complete = (command, options) => completePhase2(command, { ...f, ...options });
  f.acknowledge = (command, comment, validation, binding, completion) => acknowledgeApproval(command, comment, {
    ...f, delivery: createNoticeStore(storage), validation, binding, completion
  });
  f.reject = (command, comment, rejectionCode) => acknowledgeApproval(command, comment, {
    ...f, delivery: createNoticeStore(storage), rejectionCode
  });
  f.store = createApprovalStore(storage);
  return f;
}
const bind = f => bindApproval(f.command, structuredClone(f.issue), structuredClone(f.comment), f);
const text = f => JSON.stringify(f.posted.map(value => value.payload));

test('selects exact destination Done even when Closed is also in the Done category', () => {
  assert.equal(selectDoneTransition(choices).id, '31');
  assert.throws(() => selectDoneTransition([{ id: '41', name: 'Done', to: closed }]), { code: 'DONE_TRANSITION_UNAVAILABLE' });
  assert.throws(() => selectDoneTransition([...choices, { id: '51', to: { ...done, id: '999' } }]), { code: 'DONE_TRANSITION_AMBIGUOUS' });
});

test('another selected teammate completes approval, exact Done, then a confirmed bot success reply', async () => {
  const f = fixture();
  const result = await checkApproval(f.event, f);
  assert.equal(result.completion.code, 'PHASE2_DONE_CONFIRMED');
  assert.equal(result.acknowledgement.code, 'BOT_ACK_POSTED');
  assert.deepEqual(f.transitions, [{ issueId: '12345', transitionId: '31' }]);
  assert.equal(f.issue.fields.status.name, 'Done');
  assert.ok(text(f).includes('Request approved.'));
  assert.ok(text(f).includes('This ticket is now Done.'));
  assert.doesNotMatch(text(f), /Access granted|provisioning is pending|No access has been changed/);
});

test('the same event after Done resumes the saved result without repeated writes', async () => {
  const f = fixture();
  await checkApproval(f.event, f);
  const repeated = await checkApproval(f.event, f);
  assert.equal(repeated.status, 'completion-resumed');
  assert.equal(repeated.completion.status, 'done');
  assert.equal(repeated.acknowledgement.code, 'BOT_ACK_ALREADY_POSTED');
  assert.equal(f.transitions.length, 1);
  assert.equal(f.posted.length, 1);
});

test('a reply can resume after Done if its first invocation stopped before posting', async () => {
  const f = fixture();
  await checkApproval(f.event, { ...f, acknowledge: undefined });
  assert.equal(f.posted.length, 0);
  const repeated = await checkApproval(f.event, f);
  assert.equal(repeated.acknowledgement.code, 'BOT_ACK_POSTED');
  assert.equal(f.transitions.length, 1);
  assert.ok(text(f).includes('This ticket is now Done'));
});

for (const [name, mutate, code, expected] of [
  ['self approval', f => { f.issue.fields.reporter.accountId = f.command.authorAccountId; }, 'SELF_APPROVAL', 'cannot approve your own request'],
  ['another commenter', f => { f.issue.fields[TARGET.approverField][0] = { accountId: 'other' }; }, 'NOT_DESIGNATED_APPROVER', 'Only the person selected'],
  ['missing approver', f => { f.issue.fields[TARGET.approverField] = null; }, 'SINGLE_APPROVER_REQUIRED', 'Select exactly one Approver']
]) {
  test(`${name} gets a clear failure reply and cannot move the ticket`, async () => {
    const f = fixture(); mutate(f);
    const result = await checkApproval(f.event, f);
    assert.equal(result.code, code);
    assert.equal(f.transitions.length, 0);
    assert.equal(f.issue.fields.status.name, 'To Do');
    assert.ok(text(f).includes(expected));
    assert.ok(!text(f).includes('This ticket is now Done'));
  });
}

test('missing Site ID gets a specific failure message and no Done attempt', async () => {
  const f = fixture(); f.issue.fields[F.siteId] = null;
  await checkApproval(f.event, f);
  assert.equal(f.transitions.length, 0);
  assert.ok(text(f).includes('Enter the Site ID required for Account Access'));
  assert.ok(text(f).includes('new Grant access comment'));
});

test('a changed request cannot use its old approval to transition', async () => {
  const f = fixture(); await bind(f);
  f.issue.fields[F.siteId] = 'CHANGED';
  const result = await completePhase2(f.command, f);
  assert.equal(result.code, 'APPROVAL_NO_LONGER_CURRENT');
  assert.equal(f.transitions.length, 0);
});

test('unreadable change history stops Done before any status write', async () => {
  const f = fixture(); await bind(f);
  f.client.getHistory = async () => { throw new Error('Private SDK failure'); };
  const result = await completePhase2(f.command, f);
  assert.equal(result.code, 'COMPLETION_CHECK_UNAVAILABLE');
  assert.equal(f.transitions.length, 0);
  assert.ok(!JSON.stringify(f.logs).includes('Private SDK failure'));
});

test('Closed alone never substitutes for an unavailable Done transition', async () => {
  const f = fixture(); f.bot.getTransitions = async () => [choices[0]];
  await checkApproval(f.event, f);
  assert.equal(f.transitions.length, 0);
  assert.ok(text(f).includes('Jira does not currently allow this ticket to move to Done'));
  assert.ok(!text(f).includes('This ticket is now Done'));
});

test('denied transition produces an English failure and never claims success', async () => {
  const f = fixture();
  f.bot.transition = async () => { throw botError('BOT_PERMISSION_DENIED'); };
  await checkApproval(f.event, f);
  assert.ok(text(f).includes('This request could not be completed automatically'));
  assert.ok(!text(f).includes('This ticket is now Done'));
  assert.equal(f.issue.fields.status.name, 'To Do');
});

test('a lost transition response is reconciled by reading back exact Done', async () => {
  const f = fixture(); await bind(f);
  const transition = f.bot.transition;
  f.bot.transition = async (...args) => { await transition(...args); throw botError('BOT_CONNECTION_FAILED'); };
  assert.equal((await completePhase2(f.command, f)).status, 'done');
  assert.equal(f.transitions.length, 1);
});

test('a successful HTTP response without exact Done is not a success', async () => {
  const f = fixture(); await bind(f);
  f.bot.transition = async () => { f.issue.fields.status = closed; };
  assert.equal((await completePhase2(f.command, f)).code, 'DONE_NOT_CONFIRMED');
});

test('a relevant edit during the transition results in a review message', async () => {
  const f = fixture(); await bind(f);
  const transition = f.bot.transition;
  f.bot.transition = async (...args) => { await transition(...args); f.issue.fields[F.siteId] = 'CHANGED'; };
  assert.equal((await completePhase2(f.command, f)).code, 'APPROVAL_NO_LONGER_CURRENT');
});

test('concurrent event deliveries cannot repeat the status transition or final comment', async () => {
  const f = fixture();
  await Promise.all([checkApproval(f.event, f), checkApproval(f.event, f)]);
  assert.equal(f.transitions.length, 1);
  assert.equal(f.posted.length, 1);
  assert.ok(text(f).includes('This ticket is now Done'));
});

test('a processing guard left by a crash does not cause an automatic transition retry', async () => {
  const f = fixture(); await bind(f); await f.completionStore.claim(f.command);
  assert.equal((await completePhase2(f.command, f)).status, 'in-progress');
  assert.equal(f.transitions.length, 0);
});

test('completion storage failure prevents Done and explains manual review', async () => {
  const f = fixture(); await bind(f);
  f.completionStore.get = async () => { throw new Error('Private storage failure'); };
  assert.equal((await completePhase2(f.command, f)).code, 'COMPLETION_STORAGE_FAILED');
  assert.equal(f.transitions.length, 0);
});

test('a bound approval without confirmed completion never claims Done', () => {
  const payload = acknowledgementPayload({ issueKey: 'KAN-99', commentId: '67890' }, {},
    { valid: true, code: 'REQUIRED_FIELDS_VALID', errorCodes: [] }, { status: 'bound' });
  assert.ok(JSON.stringify(payload).includes('move to Done was not confirmed'));
  assert.ok(!JSON.stringify(payload).includes('This ticket is now Done'));
});

test('update monitoring cannot invalidate an unchanged approval just because status became Done', async () => {
  const f = fixture(); await bind(f); await completePhase2(f.command, f);
  f.bindings.list = async () => [await f.bindings.get('12345', '67890')];
  const result = await checkRequestUpdate({ eventType: 'avi:jira:updated:issue', issue: f.issue }, {
    ...f, notify: () => assert.fail('Done alone must not cause a stale-approval warning')
  });
  assert.equal(result.invalidated, 0);
});

test('a new approval on an already Done ticket does not create another completion', async () => {
  const f = fixture(); f.issue.fields.status = structuredClone(done);
  const result = await checkApproval(f.event, f);
  assert.equal(result.code, 'REQUEST_ALREADY_DONE');
  assert.equal(f.transitions.length, 0);
  assert.ok(text(f).includes('already in a completed status'));
});
test('an unlabelled request creates no approval records, transition, or reply', async () => {
  const f = fixture();
  f.issue.fields.labels = [];

  const result = await checkApproval(f.event, f);

  assert.equal(result.status, 'ignored');
  assert.equal(f.data.size, 0);
  assert.equal(f.transitions.length, 0);
  assert.equal(f.posted.length, 0);
  assert.equal(f.issue.fields.status.name, 'To Do');
});

test('label removal before the final approval check prevents Done and a reply', async () => {
  const f = fixture();

  // Simulate removal while the bot reads available transitions.
  f.bot.getTransitions = async () => {
    f.issue.fields.labels = [];
    return structuredClone(choices);
  };

  const result = await checkApproval(f.event, f);

  assert.equal(result.completion.code, 'APPROVAL_NO_LONGER_CURRENT');
  assert.equal(result.acknowledgement.status, 'ignored');
  assert.equal(f.transitions.length, 0);
  assert.equal(f.posted.length, 0);
  assert.equal(f.issue.fields.status.name, 'To Do');
});

test('label removal during the transition suppresses the reply without undoing Done', async () => {
  const f = fixture();
  const transition = f.bot.transition;

  f.bot.transition = async (...args) => {
    await transition(...args);
    f.issue.fields.labels = [];
  };

  const result = await checkApproval(f.event, f);

  assert.equal(result.completion.code, 'APPROVAL_NO_LONGER_CURRENT');
  assert.equal(result.acknowledgement.status, 'ignored');
  assert.equal(f.transitions.length, 1);
  assert.equal(f.issue.fields.status.name, 'Done');
  assert.equal(f.posted.length, 0);
});
test('removing the label invalidates approval and sends one explanation', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  const record = await f.bindings.get('12345', '67890');
  f.bindings.list = async () => [record];

  f.issue.fields.labels = [];
  f.issue.fields.updated = '2026-10-28T02:01:00.000Z';

  const change = {
    fieldId: 'labels',
    fromString: 'access-automation',
    toString: null
  };

  f.histories.push({
    created: f.issue.fields.updated,
    items: [change]
  });

  const result = await checkRequestUpdate({
    eventType: 'avi:jira:updated:issue',
    issue: f.issue,
    changelog: { items: [change] }
  }, {
    ...f,
    notify: (record, comment, binding) => acknowledgeApproval(
      record,
      comment,
      {
        ...f,
        binding,
        delivery: createNoticeStore(
          f.storage,
          'approval-change-notice:v1'
        )
      }
    )
  });

  assert.equal(result.invalidated, 1);
  assert.equal(f.posted.length, 1);
  assert.match(text(f), /label was removed/i);
  assert.match(text(f), /does not restore approval/i);
  assert.equal(f.transitions.length, 0);
  assert.equal(
    (await f.bindings.getInvalidation(record)).state,
    'invalidated'
  );
});

test('an unrelated label update does not invalidate approval or send a warning', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  const record = await f.bindings.get('12345', '67890');
  f.bindings.list = async () => [record];

  f.issue.fields.labels.push('urgent');
  f.issue.fields.updated = '2026-10-28T02:01:00.000Z';

  const change = {
    fieldId: 'labels',
    fromString: 'access-automation',
    toString: 'access-automation urgent'
  };

  f.histories.push({
    created: f.issue.fields.updated,
    items: [change]
  });

  const result = await checkRequestUpdate({
    eventType: 'avi:jira:updated:issue',
    issue: f.issue,
    changelog: { items: [change] }
  }, {
    ...f,
    notify: () => assert.fail('An unrelated label needs no warning')
  });

  assert.equal(result.invalidated, 0);
  assert.equal(await f.bindings.getInvalidation(record), undefined);
});
test('restoring the label does not send an old approval notification', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  const record = await f.bindings.get('12345', '67890');
  f.bindings.list = async () => [record];

  const monitor = change => checkRequestUpdate({
    eventType: 'avi:jira:updated:issue',
    issue: f.issue,
    changelog: { items: [change] }
  }, {
    ...f,
    notify: (record, comment, binding) => acknowledgeApproval(
      record,
      comment,
      {
        ...f,
        binding,
        delivery: createNoticeStore(
          f.storage,
          'approval-change-notice:v1'
        )
      }
    )
  });

  // Remove the label: explain the invalidation once, even while opted out.
  f.issue.fields.labels = [];
  f.issue.fields.updated = '2026-10-28T02:01:00.000Z';

  const removal = {
    fieldId: 'labels',
    fromString: 'access-automation',
    toString: null
  };

  f.histories.push({
    created: f.issue.fields.updated,
    items: [removal]
  });

  await monitor(removal);
  assert.equal(f.posted.length, 1);

  // Restore the label: this must not announce the old approval.
  f.issue.fields.labels = ['access-automation'];
  f.issue.fields.updated = '2026-10-28T02:02:00.000Z';

  const restoration = {
    fieldId: 'labels',
    fromString: null,
    toString: 'access-automation'
  };

  f.histories.push({
    created: f.issue.fields.updated,
    items: [restoration]
  });

  await monitor(restoration);

  assert.equal(f.posted.length, 1);
  assert.equal(f.transitions.length, 0);
  assert.equal(
    (await f.bindings.getInvalidation(record)).state,
    'invalidated'
  );
});
test('missed label removal still invalidates approval without restarting warnings', async () => {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');

  const record = await f.bindings.get('12345', '67890');
  f.bindings.list = async () => [record];

  let notifications = 0;

  const monitor = change => checkRequestUpdate({
    eventType: 'avi:jira:updated:issue',
    issue: f.issue,
    changelog: { items: [change] }
  }, {
    ...f,
    notify: async () => { notifications++; }
  });

  const removal = {
    fieldId: 'labels',
    fromString: 'access-automation',
    toString: null
  };

  const restoration = {
    fieldId: 'labels',
    fromString: null,
    toString: 'access-automation'
  };

  // Both changes exist in history, but neither was processed yet.
  // The current ticket has the label restored.
  f.histories.push(
    {
      created: '2026-10-28T02:01:00.000Z',
      items: [removal]
    },
    {
      created: '2026-10-28T02:02:00.000Z',
      items: [restoration]
    }
  );

  f.issue.fields.updated = '2026-10-28T02:02:00.000Z';

  // Only the restoration event reaches the monitor.
  const result = await monitor(restoration);

  assert.equal(result.invalidated, 1);
  assert.equal(notifications, 1);
  assert.equal(
    (await f.bindings.getInvalidation(record)).state,
    'invalidated'
  );

  // Another relevant edit must not restart this old approval's warning.
  f.issue.fields[F.siteId] = 'UPDATED-SITE';
  await monitor({ fieldId: F.siteId });

  assert.equal(notifications, 1);
  assert.equal(f.transitions.length, 0);
});

// Prepare an existing bound approval whose label was subsequently removed.
// This uses the real binding, invalidation and delivery stores with fake Jira
// responses, so the notification exception is exercised end to end.
async function labelRemovalFixture() {
  const f = fixture();
  assert.equal((await bind(f)).status, 'bound');
  f.record = await f.bindings.get('12345', '67890');
  f.bindings.list = async () => [f.record];
  f.issue.fields.labels = [];
  f.issue.fields.updated = '2026-10-28T02:01:00.000Z';
  f.change = { fieldId: 'labels', fromString: 'access-automation', toString: null };
  f.histories.push({ created: f.issue.fields.updated, items: [f.change] });
  f.update = { eventType: 'avi:jira:updated:issue', issue: f.issue,
    changelog: { items: [f.change] } };
  f.notify = (record, comment, binding) => acknowledgeApproval(record, comment, {
    ...f, binding, delivery: createNoticeStore(f.storage, 'approval-change-notice:v1')
  });
  return f;
}

test('concurrent label removal events send only one invalidation comment', async () => {
  const f = await labelRemovalFixture();
  await Promise.all([checkRequestUpdate(f.update, f), checkRequestUpdate(f.update, f)]);
  assert.equal(f.posted.length, 1);
  assert.match(text(f), /label was removed/i);
  assert.equal(f.transitions.length, 0);
  f.issue.fields[F.siteId] = 'LATER-CHANGE';
  await checkRequestUpdate({ ...f.update, changelog: { items: [{ fieldId: F.siteId }] } }, f);
  assert.equal(f.posted.length, 1);
});

test('label removal is explained even when event change metadata is missing', async () => {
  const f = await labelRemovalFixture();
  delete f.update.changelog;
  await checkRequestUpdate(f.update, f);
  assert.equal(f.posted.length, 1);
  assert.match(text(f), /label was removed/i);
});

test('the label removal comment preserves the original approval visibility', async () => {
  const f = await labelRemovalFixture();
  f.comment.visibility = { type: 'role', identifier: '10002' };
  await checkRequestUpdate(f.update, f);
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.posted[0].payload.visibility, f.comment.visibility);
});

test('unlabelled legacy evidence with no confirmed removal does not produce a comment', async () => {
  const f = await labelRemovalFixture();
  f.histories.length = 0;
  await checkRequestUpdate(f.update, f);
  assert.equal(f.posted.length, 0);
});

test('opting in only after the approval and then removing it cannot enable a removal notice', async () => {
  const f = await labelRemovalFixture();
  f.histories.unshift({ created: '2026-10-28T02:00:30.000Z', items: [{
    fieldId: 'labels', fromString: null, toString: 'access-automation'
  }] });
  await checkRequestUpdate(f.update, f);
  assert.equal(f.posted.length, 0);
});

test('a removal notice flag without a saved invalidation cannot bypass opt-out', async () => {
  const f = await labelRemovalFixture();
  const result = await f.notify(f.record, f.comment, {
    status: 'stale', code: 'AUTOMATION_OPT_IN_REMOVED', noticeKind: 'label-removal'
  });
  assert.equal(result.status, 'ignored');
  assert.equal(f.posted.length, 0);
});

test('missing private evidence cannot enable a removal notice even after label restoration', async () => {
  const f = await labelRemovalFixture();
  await f.bindings.invalidate(f.record, 'AUTOMATION_OPT_IN_REMOVED');
  f.issue.fields.labels = ['access-automation'];
  f.bindings.get = async () => undefined;
  const result = await f.notify(f.record, f.comment, {
    status: 'stale', code: 'AUTOMATION_OPT_IN_REMOVED', noticeKind: 'label-removal'
  });
  assert.equal(result.status, 'ignored');
  assert.equal(f.posted.length, 0);
});

test('a moved request cannot receive a removal notice in another project', async () => {
  const f = await labelRemovalFixture();
  await f.bindings.invalidate(f.record, 'AUTOMATION_OPT_IN_REMOVED');
  f.issue.fields.project.id = '99999';
  const result = await f.notify(f.record, f.comment, {
    status: 'stale', code: 'AUTOMATION_OPT_IN_REMOVED', noticeKind: 'label-removal'
  });
  assert.equal(result.status, 'ignored');
  assert.equal(f.posted.length, 0);
});

test('unreadable label history cannot authorize an opt-out notification', async () => {
  const f = await labelRemovalFixture();
  await f.bindings.invalidate(f.record, 'AUTOMATION_OPT_IN_REMOVED');
  f.client.getHistory = async () => { throw new Error('Private history details'); };
  const result = await f.notify(f.record, f.comment, {
    status: 'stale', code: 'AUTOMATION_OPT_IN_REMOVED', noticeKind: 'label-removal'
  });
  assert.equal(result.status, 'manual-review');
  assert.equal(f.posted.length, 0);
  assert.ok(!JSON.stringify(f.logs).includes('Private history details'));
});

test('removal notice evidence is checked again immediately before posting', async () => {
  const f = await labelRemovalFixture();
  f.bot.verifyIdentity = async () => {
    // Simulate a later storage read no longer confirming the invalidation.
    f.bindings.getInvalidation = async () => undefined;
  };
  await checkRequestUpdate(f.update, f);
  assert.equal(f.posted.length, 0);
  assert.equal([...f.data.keys()].filter(key => key.startsWith('approval-change-notice:v1:')).length, 1);
});

test('a move during notification checks prevents posting into the other project', async () => {
  const f = await labelRemovalFixture();
  f.bot.verifyIdentity = async () => { f.issue.fields.project.id = '99999'; };
  await checkRequestUpdate(f.update, f);
  assert.equal(f.posted.length, 0);
});
c