import { createHash } from 'node:crypto';
import { TARGET, verifyDesignatedApprover } from './approval.mjs';
import { REQUEST_FIELDS as F, validateRequest } from './request.mjs';
import {
  AUTOMATION_LABEL,
  hasAutomationLabel
} from './automation.mjs';
// Stable JSON avoids treating a change in JSON object-key order as an edit.
// Description is hashed so its potentially sensitive text need not be copied
// into app storage. Names, avatars, assignee, and discussion comments are not
// access parameters and deliberately do not enter the approved snapshot.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])])
  );
  return value ?? null;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const choice = value => ({ id: value?.id ?? null, value: value?.value ?? null });

export function requestSnapshot(issue) {
  const fields = issue.fields;
  const people = fields[TARGET.approverField];
  const approver = Array.isArray(people) ? people[0] : people;
  const type = fields[F.accessType]?.value;
  const access = type === 'Account Access' ? {
    accountId: fields[F.accountId], siteId: fields[F.siteId]
  } : type === 'Role Access' ? { role: choice(fields[F.role]) }
    : { platform: choice(fields[F.platform]) };
  return {
    projectId: String(fields.project.id), issueTypeId: String(fields.issuetype.id),
    reporterAccountId: fields.reporter.accountId, approverAccountId: approver.accountId,
    summaryHash: fingerprint(fields.summary), descriptionHash: fingerprint(fields.description),
    category: choice(fields[F.category]), component: choice(fields[F.component]),
    accessType: choice(fields[F.accessType]), access
  };
}

const commonFields = ['project', 'issuetype', 'reporter', 'summary', 'description',
  TARGET.approverField, F.category, F.component, F.accessType];
const aliases = {
  'issue type': 'issuetype', 'work type': 'issuetype', approver: TARGET.approverField,
  category: F.category, component: F.component, 'access type': F.accessType,
  'account id': F.accountId, 'site id': F.siteId, 'role access': F.role, 'platform access': F.platform
};
function changedField(item) {
  const id = item?.fieldId;
  if (typeof id === 'string' && id) return id;
  const name = typeof item?.field === 'string' ? item.field.toLowerCase() : '';
  return aliases[name] ?? name;
}
function relevantFields(snapshot) {
  return new Set([...commonFields, ...(snapshot.accessType.value === 'Account Access'
    ? [F.accountId, F.siteId] : snapshot.accessType.value === 'Role Access' ? [F.role] : [F.platform])]);
}

export function isRelevantUpdate(event) {
  const items = event?.changelog?.items;
  // Missing metadata is not evidence that an update was harmless. In that
  // case, inspect canonical history instead of silently trusting the event.
  if (!Array.isArray(items)) return true;
  const fields = new Set(['labels', ...commonFields, ...Object.values(F)]);
  return items.some(item => fields.has(changedField(item)));
}
// Use the canonical history fetched from Jira, not the event's
// potentially incomplete or redacted before/after values.
function automationOptInState(item) {
  function containedOptIn(text, rawValue) {
    if (typeof text === 'string') {
      return text.split(/\s+/).includes(AUTOMATION_LABEL);
    }

    // Explicit null with no raw value represents an empty field.
    if (text === null && rawValue == null) {
      return false;
    }

    // Missing or unreadable history cannot prove approval is still valid.
    throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
  }

  const before = containedOptIn(item.fromString, item.from);
  const after = containedOptIn(item.toString, item.to);

  return { before, after };
}

function automationOptInChanged(item) {
  const { before, after } = automationOptInState(item);
  return before !== after;
}

// A missing label today is not proof that one was removed after approval.
// Inspect complete canonical history: the first opt-in change after approval
// must be a removal. This excludes requests that only opted in afterwards,
// and still detects a removal followed by restoration between event deliveries.
export function labelRemovedSinceApproval(histories, approvedAt) {
  const cutoff = Date.parse(approvedAt);
  if (!Array.isArray(histories) || !Number.isFinite(cutoff)) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
  let firstTime = Infinity, firstRemoval;
  for (const history of histories) {
    const time = Date.parse(history?.created);
    if (!Number.isFinite(time) || !Array.isArray(history.items)) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
    if (time < cutoff) continue;
    for (const item of history.items) {
      if (changedField(item) !== 'labels') continue;
      const { before, after } = automationOptInState(item);
      if (before === after) continue;
      if (time === firstTime && firstRemoval !== before) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
      if (time < firstTime) {
        firstTime = time;
        firstRemoval = before;
      }
    }
  }
  return firstRemoval === true;
}
export function changedSinceApproval(histories, approvedAt, snapshot) {
  const cutoff = Date.parse(approvedAt), relevant = relevantFields(snapshot);
  if (!Array.isArray(histories) || !Number.isFinite(cutoff)) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
  for (const history of histories) {
    const time = Date.parse(history?.created);
    if (!Number.isFinite(time) || !Array.isArray(history.items)) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
    if (time >= cutoff) {
      // Equal timestamps cannot prove whether a field edit preceded approval.
      // Require fresh approval rather than assume an ordering within that ms.
      if (history.items.some(item => !changedField(item))) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
      if (history.items.some(item => {
        const field = changedField(item);
        if (field === 'labels') return automationOptInChanged(item);
        return relevant.has(field);
      })) return true;
    }
  }
  return false;
}

// The dedicated changelog endpoint is paginated. Never silently use a truncated
// issue.expand.changelog result. Incomplete or changing pagination fails closed.
export async function readCompleteHistory(getPage) {
  const histories = [];
  let startAt = 0, total;
  for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
    const page = await getPage(startAt);
    if (page?.startAt !== startAt || !Array.isArray(page.values) ||
        !Number.isInteger(page.total) || page.total < 0 || typeof page.isLast !== 'boolean' ||
        (total !== undefined && total !== page.total)) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
    total = page.total;
    histories.push(...page.values);
    startAt += page.values.length;
    if (startAt > total) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
    if (page.isLast) {
      if (startAt !== total) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
      return histories;
    }
    if (!page.values.length || startAt >= total) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
  }
  throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
}

const stale = code => ({ status: 'stale', code });
const unavailable = () => ({ status: 'manual-review', code: 'APPROVAL_BINDING_CHECK_UNAVAILABLE' });

async function inspect(command, issue, comment, client, { allowCompleted = false } = {}) {
  // Approval can only remain usable while the ticket is opted in.
  if (!hasAutomationLabel(issue)) return stale('AUTOMATION_OPT_IN_REMOVED');
  if (!verifyDesignatedApprover(command, issue, comment, { allowCompleted }).matched) return stale('APPROVAL_IDENTITY_CHANGED');
  if (!validateRequest(issue).valid) return stale('APPROVED_DETAILS_CHANGED');
  if (!Number.isFinite(Date.parse(issue.fields.updated))) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
  const snapshot = requestSnapshot(issue), digest = fingerprint(snapshot);
  let observed = issue;
  for (let attempt = 0; attempt < 2; attempt++) {
    const history = await client.getHistory(command.issueId);
    if (changedSinceApproval(history, comment.created, snapshot)) return stale('APPROVED_DETAILS_CHANGED');

    // Read again after history. If an unrelated edit changed Jira's updated
    // timestamp, retry with fresh history; do not revoke for an assignee change.
    // This also catches edit/revert occurring while the first history read ran.
    const [latest, latestComment] = await Promise.all([
      client.getIssue(command.issueId), client.getComment(command.issueId, command.commentId)
    ]);
    // The label might have been removed while we were reading history.
    if (!hasAutomationLabel(latest)) return stale('AUTOMATION_OPT_IN_REMOVED');
    if (!Number.isFinite(Date.parse(latest.fields?.updated))) throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
    if (!verifyDesignatedApprover(command, latest, latestComment, { allowCompleted }).matched ||
        latestComment.created !== comment.created || !validateRequest(latest).valid ||
        fingerprint(requestSnapshot(latest)) !== digest) return stale('REQUEST_CHANGED_DURING_APPROVAL_CHECK');
    if (latest.fields.updated === observed.fields.updated) return { status: 'checked', snapshot, fingerprint: digest };
    observed = latest;
  }
  // Continuous concurrent edits mean no stable read could be established.
  // Pause for review without permanently invalidating for unrelated activity.
  throw new Error('APPROVAL_HISTORY_UNAVAILABLE');
}

export async function bindApproval(command, issue, comment, { client, bindings, now }) {
  try {
    const checked = await inspect(command, issue, comment, client);
    if (checked.status !== 'checked') return checked;
    const record = {
      schemaVersion: 1, state: 'bound', issueId: command.issueId, issueKey: command.issueKey,
      commentId: command.commentId, authorAccountId: command.authorAccountId,
      commentCreatedAt: comment.created, boundAt: now(),
      snapshot: checked.snapshot, fingerprint: checked.fingerprint
    };
    if (await bindings.getInvalidation(record) !== undefined) return stale('APPROVAL_ALREADY_INVALIDATED');
    await bindings.save(record);
    return { status: 'bound', code: 'APPROVAL_BOUND_TO_REQUEST' };
  } catch { return unavailable(); }
}

// This is the freshness gate before completing Phase 2. An
// old identity-only record is insufficient. Read the exact binding by key,
// check permanent invalidation, and re-read Jira/history before moving to Done.
// Update-event notifications and their eventually consistent queries are never
// the authority for completing approval. allowCompleted is used only to verify
// the same approval after a confirmed Done transition, resume its result reply,
// or monitor changes without treating Done itself as an identity change.
export async function verifyBoundApproval(issueId, commentId, { client, bindings, allowCompleted = false }) {
  try {
    const record = await bindings.get(issueId, commentId);
    if (!record) return { status: 'manual-review', code: 'APPROVAL_BINDING_REQUIRED' };
    if (record.state !== 'bound' || record.schemaVersion !== 1 ||
        record.issueId !== issueId || record.commentId !== commentId ||
        fingerprint(record.snapshot) !== record.fingerprint) return unavailable();
    if (await bindings.getInvalidation(record) !== undefined) return stale('APPROVAL_ALREADY_INVALIDATED');
    const [issue, comment] = await Promise.all([client.getIssue(issueId), client.getComment(issueId, commentId)]);
    const checked = await inspect(record, issue, comment, client, { allowCompleted });
    const result = checked.status === 'checked'
      ? checked.fingerprint === record.fingerprint && comment.created === record.commentCreatedAt
        ? { status: 'current', code: 'BOUND_APPROVAL_CURRENT' } : stale('APPROVED_DETAILS_CHANGED')
      : checked;
    if (result.status === 'stale') await bindings.invalidate(record, result.code);
    return result;
  } catch { return unavailable(); }
}

// This narrowly scoped exception authorizes an invalidation COMMENT only.
// Require both app-private evidence and Jira history before posting without
// the opt-in label. A caller-supplied flag or a never-labelled ticket alone
// must not bypass the normal label gate. Recheck this immediately before POST.
export async function verifyLabelRemovalNotice(command, issue, { client, bindings }) {
  if (!bindings || String(issue?.id) !== command.issueId ||
      String(issue.fields?.project?.id) !== TARGET.projectId ||
      String(issue.fields?.issuetype?.id) !== TARGET.issueTypeId) return false;
  const record = await bindings.get(command.issueId, command.commentId);
  if (!record || record.state !== 'bound' || record.schemaVersion !== 1 ||
      record.issueId !== command.issueId || record.commentId !== command.commentId ||
      fingerprint(record.snapshot) !== record.fingerprint) return false;
  const invalidation = await bindings.getInvalidation(record);
  if (invalidation?.state !== 'invalidated' || invalidation.issueId !== record.issueId ||
      invalidation.commentId !== record.commentId) return false;
  return labelRemovedSinceApproval(await client.getHistory(command.issueId), record.commentCreatedAt);
}
