import { BOT_MESSAGES } from './bot.mjs';
import { verifyBoundApproval } from './binding.mjs';

export const COMPLETION_MESSAGES = Object.freeze({
  ...BOT_MESSAGES,
  BOT_CONNECTION_FAILED: 'The connection to Jira failed, so the bot could not confirm the move to Done. Check the ticket’s current status before retrying.',
  BOT_RESPONSE_INVALID: 'Jira returned an unexpected response, so the bot could not confirm the move to Done. An administrator needs to check this ticket.',
  DONE_TRANSITION_UNAVAILABLE: 'Jira does not currently allow this ticket to move to Done. Ask an administrator to check the workflow and the bot’s Transition issues permission.',
  DONE_TRANSITION_AMBIGUOUS: 'The workflow has more than one possible Done destination. An administrator needs to select the intended status.',
  DONE_NOT_CONFIRMED: 'The bot could not confirm that the ticket reached Done. Check its current status before retrying.',
  APPROVAL_NO_LONGER_CURRENT: 'The request details or approver changed after approval. Review the current details and ask the selected Approver for a new Grant access comment.',
  COMPLETION_STORAGE_FAILED: 'The approval completion record could not be saved or checked. An administrator needs to review the ticket before retrying.',
  COMPLETION_CHECK_UNAVAILABLE: 'The approval history could not be verified. Ask an administrator to check this request before retrying.'
});

const fail = code => ({ status: 'manual-review', code, reason: COMPLETION_MESSAGES[code] });
const codedError = code => Object.assign(new Error(code), { code });
const isDone = status => typeof status?.name === 'string' && status.name.trim().toLowerCase() === 'done';

export function selectDoneTransition(transitions) {
  // A Closed status can also be in Jira's Done category. Match the actual
  // destination name, not the category or transition's display label.
  const choices = transitions.filter(transition => isDone(transition.to) &&
    /^\d+$/.test(String(transition.id)) && /^\d+$/.test(String(transition.to.id)));
  if (!choices.length) throw codedError('DONE_TRANSITION_UNAVAILABLE');
  if (new Set(choices.map(transition => String(transition.to.id))).size !== 1) {
    throw codedError('DONE_TRANSITION_AMBIGUOUS');
  }
  return choices[0];
}

export function createCompletionStore(storage) {
  const keyFor = command => `phase2-completion:v1:${command.issueId}:${command.commentId}`;
  return {
    async get(command) { return storage.get(keyFor(command)); },
    async claim(command) {
      const key = keyFor(command);
      try {
        await storage.set(key, { state: 'processing' }, { keyPolicy: 'FAIL_IF_EXISTS' });
        return true;
      } catch {
        if (await storage.get(key) !== undefined) return false;
        throw codedError('COMPLETION_STORAGE_FAILED');
      }
    },
    async finish(command, result) {
      const key = keyFor(command);
      try {
        await storage.set(key, { state: 'finished', result });
        const saved = await storage.get(key);
        if (saved?.state !== 'finished' || !saved.result ||
            Object.keys(saved.result).length !== Object.keys(result).length ||
            Object.entries(result).some(([key, value]) => saved.result[key] !== value)) {
          throw codedError('COMPLETION_STORAGE_FAILED');
        }
      } catch { throw codedError('COMPLETION_STORAGE_FAILED'); }
    }
  };
}

export async function completePhase2(command, {
  client, bindings, bot, completionStore, resumeOnly = false, log = console.info
}) {
  const report = result => {
    log('Phase 2 completion:', JSON.stringify({ issueKey: command.issueKey, commentId: command.commentId, ...result }));
    return result;
  };
  try {
    const existing = await completionStore.get(command);
    if (existing?.state === 'processing') return report({ status: 'in-progress', code: 'COMPLETION_IN_PROGRESS' });
    if (existing?.state === 'finished') {
      if (existing.result?.status !== 'done') return report(existing.result ?? fail('COMPLETION_STORAGE_FAILED'));
      // A duplicate event may arrive after Done but before the bot's comment.
      // Reconfirm status and the same approval before resuming only the reply.
      const status = await bot.getStatus(command.issueId);
      const check = await verifyBoundApproval(command.issueId, command.commentId, { client, bindings, allowCompleted: true });
      if (isDone(status) && String(status.id) === existing.result.doneStatusId && check.status === 'current') {
        return report(existing.result);
      }
      return report(fail('APPROVAL_NO_LONGER_CURRENT'));
    }
    if (existing !== undefined) return report(fail('COMPLETION_STORAGE_FAILED'));
    if (resumeOnly) return { status: 'not-recorded', code: 'NO_COMPLETION_RECORD' };
    if (!await completionStore.claim(command)) return report({ status: 'in-progress', code: 'COMPLETION_IN_PROGRESS' });

    let result;
    try {
      await bot.verifyIdentity();
      const transition = selectDoneTransition(await bot.getTransitions(command.issueId));
      // Always check canonical Jira records immediately before the status write.
      const before = await verifyBoundApproval(command.issueId, command.commentId, { client, bindings });
      if (before.status !== 'current') throw codedError(before.status === 'stale'
        ? 'APPROVAL_NO_LONGER_CURRENT' : 'COMPLETION_CHECK_UNAVAILABLE');
      let transitionError;
      try { await bot.transition(command.issueId, String(transition.id)); } catch (error) { transitionError = error; }
      // A lost HTTP response does not prove the transition failed. Read back the
      // exact target status ID rather than blindly repeating the status write.
      const status = await bot.getStatus(command.issueId);
      if (!isDone(status) || String(status.id) !== String(transition.to.id)) {
        if (transitionError) throw transitionError;
        throw codedError('DONE_NOT_CONFIRMED');
      }
      const after = await verifyBoundApproval(command.issueId, command.commentId, { client, bindings, allowCompleted: true });
      if (after.status !== 'current') throw codedError(after.status === 'stale'
        ? 'APPROVAL_NO_LONGER_CURRENT' : 'COMPLETION_CHECK_UNAVAILABLE');
      result = { status: 'done', code: 'PHASE2_DONE_CONFIRMED', doneStatusId: String(status.id) };
    } catch (error) {
      const code = Object.hasOwn(COMPLETION_MESSAGES, error?.code) ? error.code : 'COMPLETION_CHECK_UNAVAILABLE';
      result = fail(code);
    }
    await completionStore.finish(command, result);
    return report(result);
  } catch (error) {
    const code = Object.hasOwn(COMPLETION_MESSAGES, error?.code) ? error.code : 'COMPLETION_STORAGE_FAILED';
    return report(fail(code));
  }
}
