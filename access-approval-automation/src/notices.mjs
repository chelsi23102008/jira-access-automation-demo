import { BOT, BOT_MESSAGES, botError } from './bot.mjs';
import { validationParagraphs } from './request.mjs';
import { COMPLETION_MESSAGES } from './completion.mjs';
import { AUTOMATION_LABEL, hasAutomationLabel } from './automation.mjs';
import { verifyLabelRemovalNotice } from './binding.mjs';
export const REJECTION_MESSAGES = Object.freeze({
  SINGLE_APPROVER_REQUIRED: 'Select exactly one Approver, then ask that person to add a new Grant access comment.',
  NOT_DESIGNATED_APPROVER: 'Only the person selected in the Approver field can approve this request. Ask that person to add a new Grant access comment.',
  SELF_APPROVAL: 'You cannot approve your own request. Select another teammate as Approver and ask them to add a new Grant access comment.',
  SERVICE_ACCOUNT_CANNOT_APPROVE: 'The automation bot cannot approve requests. Select a teammate as Approver.',
  APP_CANNOT_APPROVE: 'An app account cannot approve requests. Select a teammate as Approver.',
  INACTIVE_APPROVER: 'The selected approver’s account is inactive. Select an active teammate and ask them to approve.',
  REPORTER_REQUIRED: 'Select the person requesting access in the Reporter field, then ask the selected Approver to add a new Grant access comment.',
  REQUEST_ALREADY_DONE: 'This ticket is already in a completed status. A new approval has not been processed.',
  APPROVAL_RECORD_FAILED: 'The approval record could not be saved. Ask an administrator to check the app before trying a new approval comment.'
});

export function acknowledgementPayload(command, comment, validation, binding, completion, rejectionCode) {
  let paragraphs = validationParagraphs(validation);
  if (rejectionCode) {
    paragraphs = ['This approval could not be accepted. ' +
      (REJECTION_MESSAGES[rejectionCode] ?? 'An administrator needs to check this request.')];
  } else if (completion?.status === 'done' && completion.code === 'PHASE2_DONE_CONFIRMED') {
    paragraphs = ['Request approved. The selected approver and all required details have been checked. This ticket is now Done.'];
  } else if (completion) {
    paragraphs = ['This request could not be completed automatically. ' +
      (COMPLETION_MESSAGES[completion.code] ?? COMPLETION_MESSAGES.COMPLETION_CHECK_UNAVAILABLE)];
  } else if (binding?.status === 'stale' && binding.code === 'AUTOMATION_OPT_IN_REMOVED' &&
      binding.noticeKind === 'label-removal') {
    paragraphs = [`The ${AUTOMATION_LABEL} label was removed, so the previous approval is no longer valid. ` +
      'Adding the label back does not restore approval. Review the current request details and ask the selected Approver ' +
      'to add a new Grant access comment.'];
  } else if (binding?.status === 'stale') {
    paragraphs = ['The request details or approver changed after this approval. This approval is no longer valid. ' +
      'Review the current request details and ask the selected Approver to add a new Grant access comment. ' +
      'Changing the details back does not restore the old approval.'];
  } else if (validation?.valid === true && binding?.status !== 'bound') {
    paragraphs = ['The approver identity was verified, but this approval could not be tied to the reviewed request details. ' +
      'An administrator needs to check the approval history or app storage before this request can proceed. ' +
      'The bot has not moved this ticket to Done.'];
  } else if (validation?.valid === true && binding?.status === 'bound') {
    // A bound approval alone is not a completed workflow. Never claim success
    // without a saved completion and read-back confirmation of exact Done.
    paragraphs = ['The approval checks passed, but the move to Done was not confirmed. Ask an administrator to check this ticket.'];
  }
  const reference = `Approval reference: ${command.issueKey}/comment-${command.commentId}`;
  const payload = { body: { type: 'doc', version: 1, content: [...paragraphs, reference].map(value => ({
    type: 'paragraph', content: [{ type: 'text', text: value }]
  })) } };
  // Preserve the source approval comment's restrictions instead of announcing
  // a restricted approval in a public comment. Reject malformed restrictions.
  if (comment.visibility != null) {
    const { type, identifier, value } = comment.visibility;
    if (!['group', 'role'].includes(type) ||
        !(typeof identifier === 'string' && identifier || typeof value === 'string' && value)) {
      throw botError('BOT_RESPONSE_INVALID');
    }
    payload.visibility = { type, ...(identifier ? { identifier } : { value }) };
  }
  return payload;
}

function docText(body) {
  if (body?.type !== 'doc' || !Array.isArray(body.content)) return null;
  const text = [];
  for (const paragraph of body.content) {
    if (paragraph?.type !== 'paragraph' || !Array.isArray(paragraph.content) ||
        paragraph.content.some(node => node?.type !== 'text' || typeof node.text !== 'string')) return null;
    text.push(paragraph.content.map(node => node.text).join(''));
  }
  return text.join('\n');
}

// A separate delivery record keeps immutable approver evidence intact. Only
// the invocation that creates the guard may POST; other deliveries never POST.
// A crash or ambiguous response leaves the guard for manual review. This is
// conservative at-most-once sending, not a claim of exactly-once delivery.
export function createNoticeStore(storage, prefix = 'approval-notice:v1') {
  const keyFor = command => `${prefix}:${command.issueId}:${command.commentId}`;
  return {
    async claim(command, startedAt) {
      const key = keyFor(command);
      try {
        await storage.set(key, { state: 'posting', startedAt }, { keyPolicy: 'FAIL_IF_EXISTS' });
        return 'claimed';
      } catch {
        let existing;
        try { existing = await storage.get(key); } catch { throw botError('NOTICE_STORAGE_FAILED'); }
        if (existing?.state === 'posted' && /^\d+$/.test(existing.botCommentId ?? '')) return 'already-posted';
        if (existing !== undefined) return 'in-progress-or-needs-review';
        throw botError('NOTICE_STORAGE_FAILED');
      }
    },
    async complete(command, botCommentId) {
      const key = keyFor(command);
      try {
        await storage.set(key, { state: 'posted', botCommentId });
        const stored = await storage.get(key);
        if (stored?.state !== 'posted' || stored.botCommentId !== botCommentId) {
          throw new Error('Read-back mismatch');
        }
      } catch { throw botError('NOTICE_STORAGE_FAILED'); }
    }
  };
}

export async function acknowledgeApproval(command, comment, {
  bot, client, bindings, delivery, validation, binding, completion, rejectionCode,
  log = console.info, now = () => new Date().toISOString()
}) {
  const identifiers = { issueKey: command.issueKey, commentId: command.commentId };
  const report = result => {
    log('Access approval acknowledgement:', JSON.stringify({ ...identifiers, ...result }));
    return result;
  };
  // Only the update monitor requests this special invalidation notice. It
  // cannot be used for a success, validation failure, or identity rejection.
  const removalNotice = binding?.status === 'stale' && binding.code === 'AUTOMATION_OPT_IN_REMOVED' &&
    binding.noticeKind === 'label-removal' && !completion && !rejectionCode && validation === undefined;
  const canComment = issue => removalNotice
    ? verifyLabelRemovalNotice(command, issue, { client, bindings })
    : hasAutomationLabel(issue);
  try {
    // Ordinary replies remain opt-in only. The removal notice additionally
    // requires a saved invalidation and confirmed label-removal history.
    const issue = await client.getIssue(command.issueId);
    if (!await canComment(issue)) return report({ status: 'ignored', code: 'AUTOMATION_NOT_ENABLED' });
    const payload = acknowledgementPayload(command, comment, validation, binding, completion, rejectionCode);
    // Verify the actual token owner before claiming or posting anything.
    await bot.verifyIdentity();
    const claim = await delivery.claim(command, now());
    if (claim === 'already-posted') return report({ status: 'already-posted', code: 'BOT_ACK_ALREADY_POSTED' });
    if (claim !== 'claimed') return report({
      status: 'manual-review', code: 'BOT_ACK_DELIVERY_UNCONFIRMED',
      reason: 'Another delivery is processing this approval, or a previous attempt needs checking. No duplicate comment was sent.'
    });
    // Recheck after the intervening operations, just before posting.
    const latestIssue = await client.getIssue(command.issueId);
    if (!await canComment(latestIssue)) return report({ status: 'ignored', code: 'AUTOMATION_NOT_ENABLED' });
    const botCommentId = await bot.postComment(command.issueId, payload);
    const saved = await bot.getComment(command.issueId, botCommentId);
    if (String(saved?.id) !== botCommentId || saved?.author?.accountId !== BOT.accountId ||
        docText(saved.body) !== docText(payload.body)) throw botError('BOT_RESPONSE_INVALID');
    await delivery.complete(command, botCommentId);
    return report({ status: 'posted', code: 'BOT_ACK_POSTED', botCommentId });
  } catch (error) {
    const code = Object.hasOwn(BOT_MESSAGES, error?.code) ? error.code : 'BOT_REQUEST_FAILED';
    return report({ status: 'manual-review', code, reason: BOT_MESSAGES[code] });
  }
}
