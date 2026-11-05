import { TARGET } from './approval.mjs';
import { isRelevantUpdate, labelRemovedSinceApproval, verifyBoundApproval } from './binding.mjs';
import { hasAutomationLabel } from './automation.mjs';

// This handler supplies timely notifications. The independent, freshly-read
// verifyBoundApproval gate remains essential because events/queries can lag.
export async function checkRequestUpdate(event, { client, bindings, notify, log = console.info }) {
  if (event?.eventType !== 'avi:jira:updated:issue' || event.selfGenerated ||
      !/^\d+$/.test(String(event.issue?.id)) || !isRelevantUpdate(event)) return { status: 'ignored' };
  const issueId = String(event.issue.id);
  const updateItems = event.changelog?.items;
  const labelsChanged = Array.isArray(updateItems) && updateItems.some(item =>
    item?.fieldId === 'labels' ||
    (typeof item?.field === 'string' && item.field.toLowerCase() === 'labels')
  );
  try {
    const records = await bindings.list(issueId);
    if (!records.length) return { status: 'no-bound-approvals' };
    let invalidated = 0;
    for (const record of records) {
      // Moving to Done must not invalidate the approval that caused it. This
      // monitor checks changed details only; it cannot authorize a transition.
      const result = await verifyBoundApproval(issueId, record.commentId, { client, bindings, allowCompleted: true });
      log('Access approval freshness:', JSON.stringify({
        issueKey: record.issueKey, commentId: record.commentId, status: result.status, code: result.code
      }));
      if (result.status !== 'stale') continue;
      invalidated++;
      // Restoring the label and later edits must not restart an old warning.
      if (result.code === 'APPROVAL_ALREADY_INVALIDATED') continue;
      // A moved issue or changed work type loses its approval but should not
      // receive access-automation messages in an unrelated project/type.
      try {
        const issue = await client.getIssue(issueId);
        if (String(issue.fields?.project?.id) !== TARGET.projectId ||
            String(issue.fields?.issuetype?.id) !== TARGET.issueTypeId) continue;
        // The event's label values may be redacted or the removal event missed.
        // Canonical history identifies the one permitted opt-out notification.
        const removed = labelRemovedSinceApproval(await client.getHistory(issueId), record.commentCreatedAt);
        if (!removed && (labelsChanged || !hasAutomationLabel(issue))) continue;
        const notification = removed ? {
          ...result, code: 'AUTOMATION_OPT_IN_REMOVED', noticeKind: 'label-removal'
        } : result;
        const comment = await client.getComment(issueId, record.commentId);
        // Keep the original comment's visibility restrictions on the notice.
        await notify(record, comment, notification);
      } catch {
        // A removed/unreadable old comment must not prevent checking other
        // approvals. Invalidation remains effective even when notice fails.
        log('Access approval freshness:', JSON.stringify({ issueKey: record.issueKey,
          commentId: record.commentId, status: 'manual-review', code: 'APPROVAL_CHANGE_NOTICE_UNAVAILABLE' }));
      }
    }
    return { status: 'checked', invalidated };
  } catch {
    log('Access approval freshness:', JSON.stringify({ issueId,
      status: 'manual-review', code: 'APPROVAL_BINDING_CHECK_UNAVAILABLE' }));
    return { status: 'manual-review', code: 'APPROVAL_BINDING_CHECK_UNAVAILABLE' };
  }
}
