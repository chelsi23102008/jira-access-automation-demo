// These records prove only that a particular comment passed the identity check.
// They are not permission to provision access. Required-field checks run
// separately; binding approval to reviewed access details is still a future step.
export function identityRecord(command, issue, comment, verifiedAt) {
  return {
    schemaVersion: 1,
    state: 'approver_identity_verified',
    issueId: command.issueId,
    issueKey: issue.key,
    commentId: command.commentId,
    approverAccountId: command.authorAccountId,
    reporterAccountId: issue.fields.reporter.accountId,
    commentCreatedAt: comment.created,
    verifiedAt
  };
}

const identityFields = [
  'schemaVersion', 'state', 'issueId', 'issueKey', 'commentId',
  'approverAccountId', 'reporterAccountId', 'commentCreatedAt'
];

function sameIdentity(stored, record) {
  return stored && identityFields.every(field => stored[field] === record[field]) &&
    typeof stored.verifiedAt === 'string' && Number.isFinite(Date.parse(stored.verifiedAt));
}

function recordError(code) {
  // Storage errors can include internal request details. Expose a stable code
  // instead of forwarding arbitrary SDK messages into application logs.
  return Object.assign(new Error(code), { code });
}

// Injecting the KVS client keeps this module testable without contacting Jira.
// FAIL_IF_EXISTS is enforced by Forge, unlike a racy get-then-set check in JS.
export function createApprovalStore(storage) {
  return {
    async save(record) {
      const key = `approval-identity:v1:${record.issueId}:${record.commentId}`;
      try {
        await storage.set(key, record, { keyPolicy: 'FAIL_IF_EXISTS' });
      } catch {
        // A conflict may be another simultaneous delivery, or the write may
        // have succeeded despite a lost response. Confirm the stored identity
        // before classifying either case as an already-recorded approval.
        let existing;
        try { existing = await storage.get(key); } catch {
          throw recordError('APPROVAL_STORAGE_UNAVAILABLE');
        }
        if (sameIdentity(existing, record)) return 'already-recorded';
        if (existing !== undefined) throw recordError('APPROVAL_RECORD_CONFLICT');
        throw recordError('APPROVAL_STORAGE_UNAVAILABLE');
      }

      // A successful read-back provides evidence that persistence worked.
      let saved;
      try { saved = await storage.get(key); } catch {
        throw recordError('APPROVAL_STORAGE_UNAVAILABLE');
      }
      if (!sameIdentity(saved, record)) throw recordError('APPROVAL_RECORD_NOT_CONFIRMED');
      return 'saved';
    }
  };
}
