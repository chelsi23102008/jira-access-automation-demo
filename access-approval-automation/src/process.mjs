import { detectApprovalCommand, verifyDesignatedApprover } from './approval.mjs';
import { identityRecord } from './records.mjs';
import { validateRequest } from './request.mjs';
import { bindApproval } from './binding.mjs';
import { hasAutomationLabel } from './automation.mjs';

export async function readJira(response, operation) {
  // Do not log arbitrary Jira response bodies, tokens, or comment contents.
  if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status}).`);
  return response.json();
}

// An injectable client lets local tests verify the workflow without Jira.
// The Jira read client never writes. The separate completion callback uses the
// verified bot to move to Done, only after identity, fields and binding pass.
export async function checkApproval(event, {
  client, store, bindings, log = console.info, now = () => new Date().toISOString(),
  acknowledge, reject, complete
}) {
  const command = detectApprovalCommand(event);
  if (!command) return { status: 'ignored' };
  // Read the current ticket. The event may contain older information.
const issue = await client.getIssue(command.issueId);

// Unlabelled requests follow the manual process.
// Stop before saving approval records, posting replies, or moving the ticket.
if (!hasAutomationLabel(issue)) {
  return { status: 'ignored' };
}

// Read the approval comment only after the ticket has opted in.
const comment = await client.getComment(
  command.issueId,
  command.commentId
);
  const result = verifyDesignatedApprover(command, issue, comment);
  const status = result.matched ? 'approver-matched' : 'approval-rejected';
  log('Access approval identity check:', JSON.stringify({
    issueKey: command.issueKey, commentId: command.commentId, status, code: result.code
  }));
  const identifiers = { issueKey: command.issueKey, commentId: command.commentId };
  if (!result.matched) {
    // A duplicate event can arrive after our own transition to Done. Only a
    // saved completion for this exact comment may resume the success reply.
    if (result.code === 'REQUEST_ALREADY_DONE' && complete) {
      const completion = await complete(command, { resumeOnly: true });
      if (completion.status !== 'not-recorded') {
        const outcome = { status: 'completion-resumed', ...identifiers, completion };
        if (completion.status !== 'in-progress' && acknowledge) {
          outcome.acknowledgement = await acknowledge(command, comment, undefined, undefined, completion);
        }
        return outcome;
      }
    }
    const outcome = { status, code: result.code, ...identifiers };
    // Moved/mismatched requests and edited commands are not trusted reply
    // targets. Known identity rejections can receive a corrective explanation.
    if (reject && !['RECORD_MISMATCH', 'COMMENT_OR_REQUEST_CHANGED'].includes(result.code)) {
      outcome.acknowledgement = await reject(command, comment, result.code);
    }
    return outcome;
  }

  let recordStatus;
  try {
    recordStatus = await store.save(identityRecord(command, issue, comment, now()));
    if (!['saved', 'already-recorded'].includes(recordStatus)) {
      throw new Error('APPROVAL_RECORD_NOT_CONFIRMED');
    }
  } catch {
    log('Access approval record:', JSON.stringify({
      ...identifiers, status: 'record-failed', code: 'APPROVAL_RECORD_FAILED'
    }));
    if (reject) return {
      ...identifiers, status: 'record-failed', code: 'APPROVAL_RECORD_FAILED',
      acknowledgement: await reject(command, comment, 'APPROVAL_RECORD_FAILED')
    };
    throw new Error('APPROVAL_RECORD_FAILED');
  }
  const recorded = {
    ...identifiers,
    status: recordStatus === 'saved' ? 'approval-recorded' : 'approval-already-recorded',
    code: recordStatus === 'saved' ? 'APPROVER_IDENTITY_RECORDED' : 'APPROVER_IDENTITY_ALREADY_RECORDED'
  };
  log('Access approval record:', JSON.stringify(recorded));
  // Check the current Jira values, not the potentially stale event snapshot.
  // A verified identity remains separate from the validity of request details.
  const validation = validateRequest(issue);
  log('Access request validation:', JSON.stringify({
    ...identifiers, code: validation.code, errorCodes: validation.errorCodes
  }));
  recorded.validation = validation;
  const binding = validation.valid
    ? await bindApproval(command, issue, comment, { client, bindings, now })
    : { status: 'fields-invalid', code: 'REQUEST_FIELDS_INVALID' };
  log('Access approval binding:', JSON.stringify({ ...identifiers, ...binding }));
  recorded.binding = binding;
  if (validation.valid && binding.status === 'bound' && complete) {
    recorded.completion = await complete(command);
  }
  if (acknowledge && recorded.completion?.status !== 'in-progress') {
    recorded.acknowledgement = await acknowledge(command, comment, validation, binding, recorded.completion);
  }
  return recorded;
}
