import { BOT } from './bot.mjs';

// Reuse the existing Jira fields. This app does not create or customize fields.
export const TARGET = Object.freeze({
  projectId: '10000', issueTypeId: '10009', approverField: 'customfield_10057'
});

// Jira comment bodies can be text or Atlassian Document Format (ADF).
// Quoted, linked, or otherwise formatted text must not become an approval.
function plainText(body) {
  if (typeof body === 'string') return body.trim();
  if (body?.type !== 'doc' || !Array.isArray(body.content)) return '';
  const paragraphs = [];
  for (const paragraph of body.content) {
    if (paragraph?.type !== 'paragraph' ||
        (paragraph.content != null && !Array.isArray(paragraph.content))) return '';
    const nodes = paragraph.content ?? [];
    if (nodes.some(node => node?.type !== 'text' ||
        typeof node.text !== 'string' || node.marks?.length)) return '';
    paragraphs.push(nodes.map(node => node.text).join(''));
  }
  return paragraphs.join('\n').trim();
}

export function detectApprovalCommand(event) {
  if (event?.eventType !== 'avi:jira:commented:issue' || event.selfGenerated) return null;
  const { issue, comment } = event;
  if (String(issue?.fields?.project?.id) !== TARGET.projectId ||
      String(issue?.fields?.issuetype?.id) !== TARGET.issueTypeId) return null;
  if (!comment || !/^grant access$/i.test(plainText(comment.body))) return null;
  // Jira emits this event for edits too. Only an unedited, new command qualifies.
  if (!comment.created || !Number.isFinite(Date.parse(comment.created)) ||
      comment.updated !== comment.created) return null;
  const authorId = comment.author?.accountId;
  if (!authorId || (event.atlassianId && event.atlassianId !== authorId) ||
      (comment.updateAuthor && comment.updateAuthor.accountId !== authorId)) return null;
  if (!/^\d+$/.test(String(issue.id)) || !/^\d+$/.test(String(comment.id)) ||
      !/^KAN-\d+$/.test(issue.key ?? '')) return null;
  return {
    issueId: String(issue.id), issueKey: issue.key,
    commentId: String(comment.id), authorAccountId: authorId
  };
}

const rejected = code => ({ matched: false, code });

// Identity checks only: these do not grant access or mark provisioning complete.
// Check the current Jira comment again because the event may be delayed.
export function verifyDesignatedApprover(command, issue, comment, { allowCompleted = false } = {}) {
  if (String(issue?.id) !== command.issueId || String(comment?.id) !== command.commentId) {
    return rejected('RECORD_MISMATCH');
  }
  const current = detectApprovalCommand({
    eventType: 'avi:jira:commented:issue', issue, comment,
    atlassianId: command.authorAccountId
  });
  if (!current || current.authorAccountId !== command.authorAccountId) {
    return rejected('COMMENT_OR_REQUEST_CHANGED');
  }
  if (!allowCompleted && issue.fields.status?.statusCategory?.key === 'done') return rejected('REQUEST_ALREADY_DONE');
  const value = issue.fields[TARGET.approverField];
  // Team-managed People fields may return one user or a one-element array.
  const approver = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  if (!approver?.accountId) return rejected('SINGLE_APPROVER_REQUIRED');
  if (approver.accountId !== current.authorAccountId) return rejected('NOT_DESIGNATED_APPROVER');
  if (current.authorAccountId === BOT.accountId) return rejected('SERVICE_ACCOUNT_CANNOT_APPROVE');
  if (approver.active === false || comment.author.active === false) return rejected('INACTIVE_APPROVER');
  if (approver.accountType === 'app' || comment.author.accountType === 'app') return rejected('APP_CANNOT_APPROVE');
  if (!issue.fields.reporter?.accountId) return rejected('REPORTER_REQUIRED');
  if (issue.fields.reporter.accountId === current.authorAccountId) return rejected('SELF_APPROVAL');
  return { matched: true, code: 'DESIGNATED_APPROVER_MATCHED' };
}
