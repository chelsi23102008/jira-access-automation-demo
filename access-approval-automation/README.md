# Access approval automation — Phase 2

This Forge app is separate from the Phase 1 app that customizes the global
Create form. Phase 1 remains unchanged.

- App ID: `917c8024-b91f-4f48-b71c-a4fec711ece1`
- Folder: `/Users/cfernandes/Documents/Projects/jira-access-automation-demo/access-approval-automation`
- Site: `chelsiasworkspace-41902378.atlassian.net`
- Project: Jira Access Automation / KAN (`10000`)
- Work type: Access Request (`10009`)

## Final Phase 2 scope

A new, unedited, plain-text `Grant access` comment on a ticket carrying the exact
lowercase label `access-automation` starts approval processing.
The app verifies the selected approver, checks the current required details,
saves the approved snapshot, moves the ticket to the exact **Done** status,
and posts the result as **AccessAutomationBot**.

Phase 2 does not grant access to any external account or platform. Its success
message means the Jira approval workflow completed. No provisioning integration,
provider credentials, demo executor, or Closed transition is required.

Success comment:

> Request approved. The selected approver and all required details have been checked. This ticket is now Done.

A failure explains the specific correction or administrator action. For example,
missing Site ID produces `Enter the Site ID required for Account Access.` and
asks for a fresh approval after correction. That path never attempts Done.
A workflow/API failure reports that completion could not be confirmed; it does
not falsely claim success or assume that an uncertain status write failed.

## Opt-in label and removal notification

Tickets without `access-automation` use the manual process: approval comments
do not start processing, create approval records, post ordinary replies, or
move them to Done. Labels with different capitalisation or extra suffixes do
not match. Adding the label after an old comment requires a new approval comment.

Removing the label invalidates an existing approval. The update monitor sends
one explanatory comment for that approval, even while the label is absent:

> The access-automation label was removed, so the previous approval is no longer valid. Adding the label back does not restore approval. Review the current request details and ask the selected Approver to add a new Grant access comment.

This exception permits an invalidation comment only, never completion or access
provisioning. The app must confirm a bound approval, a permanent invalidation in
app-private storage, the intended project/type, and complete Jira history showing
that the first opt-in change after approval was a removal. It checks that evidence
again immediately before posting. A missing label alone is insufficient, including
for legacy records. Restricted source-comment visibility is preserved.

Restoration does not reactivate approval or post another warning. Later field
edits do not restart a warning for an already invalidated approval. History can
detect removal/restoration even when the removal event was missed. Unrelated
label changes do not invalidate a current approval. Delivery uses the existing
per-approval change-notice guard; uncertain delivery still requires manual review.

This does not retroactively announce approvals already invalidated before this
code is deployed. Test the new notice using a fresh approval after deployment.
Removing the label cannot cancel a Jira write already underway or undo Done.

## Who can approve

Any active human Jira teammate selected as the ticket’s single **Approver** can
approve. There is no personal-account allowlist, demo label, fixed requester,
or manager-group restriction. The commenter must be the selected Approver and
must differ from the **Reporter**. The automation bot and app accounts cannot
approve. Jira permissions still determine who can view and comment on a ticket.

Ordinary comments are ignored. Edited, quoted, linked, or otherwise formatted
commands do not count as new approvals. The app fetches the actual Jira comment
and current issue rather than trusting the event snapshot.

## Required fields

Existing fields from Phase 1 are reused; this app creates no fields.

| Field | Jira field ID | Check |
| --- | --- | --- |
| Summary | `summary` | Nonblank |
| Reporter | `reporter` | Present; different from approver |
| Approver | `customfield_10057` | Exactly one selected person |
| Category | `customfield_10058` | One selected option |
| Component | `customfield_10059` | One selected option |
| Access Type | `customfield_10052` | Account, Role, or Platform Access |
| Labels | `labels` | Exact `access-automation` label opts into processing |
| Account ID | `customfield_10053` | Required single-line text for Account Access |
| Site ID | `customfield_10054` | Required single-line text for Account Access |
| Role Access | `customfield_10055` | Team Member, Super User, or Read Only |
| Platform Access | `customfield_10056` | EC2, AWS, or Snowflake |

Only fields relevant to the selected Access Type are checked. Description is
optional. Category/Component names are not hardcoded. These checks validate the
submitted form, not whether an external account exists or is eligible for access.

## Execution flow

1. Receive Jira’s comment event and recognize the exact command.
2. Fetch the canonical issue, stop if the opt-in label is absent, then fetch the
   comment and verify approver identity.
3. Save immutable identity evidence and read it back.
4. Validate required fields and bind approval to a stable request snapshot.
5. Claim a completion record for this exact issue/comment.
6. Verify the token belongs to AccessAutomationBot and discover available transitions.
7. Choose an exact destination named Done. Closed is never a substitute, even
   though both statuses may belong to Jira’s Done category.
8. Recheck the binding against current fields, comment, and complete Jira history.
9. POST the transition once, read back the exact target status ID, and recheck
   the approved details. A lost HTTP response is reconciled by the status read.
10. Save completion and post the final English result as the bot. Read the comment
    back to confirm its author and text.

Identity/field/binding failures stop before the transition. Known identity
rejections receive explanations. Untrusted mismatched records or edited commands
are not used as reply targets. Failed canonical Jira reads cannot authorize Done.

## Binding, history, and duplicate events

The binding includes project/type, reporter/approver IDs, Summary/Description
hashes, Category, Component, Access Type, and its relevant parameters. Stable JSON
and SHA-256 detect changed details; this is not encryption or a digital signature.
Jira history is read completely, including later pages. A relevant change at or
after approval invalidates the old approval even if the value is changed back.
A new comment creates a new approval. Unrelated assignee, priority, other labels,
and hidden access fields are excluded. Changes to the opt-in label are checked
separately in history. Status Done itself does not invalidate approval.

Storage keys are separate because each record has a different purpose:

- `approval-identity:v1:<issueId>:<commentId>`: immutable identity evidence.
- `approval-binding:v1:<issueId>:<commentId>`: immutable approved snapshot.
- `approval-invalidation:v1:<issueId>:<commentId>`: permanent invalidation.
- `phase2-completion:v1:<issueId>:<commentId>`: processing guard and final result.
- `approval-notice:v1:<issueId>:<commentId>`: final comment delivery guard.
- `approval-change-notice:v1:<issueId>:<commentId>`: change-notice delivery guard.

Atomic `FAIL_IF_EXISTS` claims prevent concurrent deliveries of the same event
from repeating the status write or bot reply. A duplicate arriving after Done
can resume an unposted success reply only after reconfirming the saved completion,
status, and original approval. A new approval on an already completed ticket does
not start another completion. Different new comments have distinct records.

Ambiguous writes or crashes can leave processing/delivery guards for manual
review. Automatic blind retries are deliberately avoided; exactly-once delivery
is not guaranteed. If the bot’s credentials, permissions, or connection prevent
commenting, the failure is available in safe app logs, not necessarily in Jira.
Jira reads and writes are not an atomic lock: concurrent edits during completion
are rechecked and reported for review, but an already applied transition is not
silently reversed. History/query traversals are capped at 25 pages and fail closed.

The issue-updated event monitors bindings after relevant edits. Notification
queries may lag; strongly consistent key reads and fresh Jira reads authorize
completion. Notifications are never the authority for moving to Done. Restricted
source comments retain their role/group visibility restrictions on bot replies.

## Code map

| File | Purpose |
| --- | --- |
| `src/index.js` | Forge entry point, clients, and handler wiring |
| `src/approval.mjs` | Command parsing and designated approver checks |
| `src/automation.mjs` | Exact opt-in label and current-label check |
| `src/process.mjs` | Ordered workflow and rejection/resume handling |
| `src/records.mjs` | Immutable identity evidence |
| `src/request.mjs` | Existing field IDs and type-specific validation |
| `src/binding.mjs` | Snapshots, complete history, freshness checks |
| `src/binding-store.mjs` | Immutable bindings and permanent invalidation |
| `src/completion.mjs` | Exact Done selection, status write/read-back, receipts |
| `src/bot.mjs` | Authenticated requests as the service account |
| `src/notices.mjs` | English result messages and guarded bot delivery |
| `src/updates.mjs` | Change monitoring and fresh-approval notices |
| `test/*.test.mjs` | Local simulated Jira/storage/bot checks |
| `manifest.yml` | Events, entry point, permissions, runtime |

Event handlers use `api.asApp()` for reads because there is no signed-in UI user.
Writes use the service account’s scoped token via the fixed Atlassian gateway.
The Forge app needs `read:jira-work`, `storage:app`, and backend access to
`https://api.atlassian.com`. This update adds no new manifest permissions or dependencies.
Tokens, authorization headers, raw error bodies, and private field values are
not logged. The fixed site and bot identity cannot be changed by ticket input.

## Bot configuration and local commands

The existing encrypted development variable is `BOT_API_TOKEN`. Never put its
value in chat, code, a command argument, or logs. To replace it, use the hidden prompt:

```sh
forge variables set --encrypt --environment development BOT_API_TOKEN
```

The token needs `read:jira-user`, `read:jira-work`, and `write:jira-work`. The bot
also needs Jira product access, Browse projects, Add comments, and Transition
issues permissions. The workflow must expose a transition into Done. Redeploy
after changing variables. Do not create a new token merely for this update.

Run from this app root using the installed supported Node 24 version:

```sh
npm test
npm run lint
forge lint --environment development
forge deploy --non-interactive --environment development
```

Install upgrades are needed for permission changes, not ordinary code changes.
The installed development app is already configured on the intended Jira site.

## Verification record

On 2026-11-03, development version **4.4.0** was deployed by the user with the
initial opt-in label behaviour; 189 local tests and both linters passed before
that deployment. The subsequent label-removal explanation change has passed
200 local tests and JavaScript lint. It has **not yet been deployed or verified
live**. No manifest permission or dependency changes are required.

Live test tickets KAN-19 through KAN-39 cover opt-in, supported access choices,
missing fields, identity checks, comment edits, and approval invalidation. KAN-35's
original description expects silent removal because it was created for 4.4.0;
the new expected result is one label-removal explanation, then no repeats after
restoration or subsequent edits. Network uncertainty and simultaneous event
redelivery are simulated locally, not established by creating test tickets.

Earlier development versions were verified live on 2026-10-28:

- 2.0.0: selected approver identity matched (KAN-5 comment 10030).
- 3.0.0: identity record saved/read back (10031).
- 4.0.0: bot acknowledgement 10033 for approval 10032.
- 4.1.0: missing Site ID failure 10035; restored valid fields reply 10037.
- 4.2.0: bound approval 10038, edit invalidation notice 10040, permanent
  invalidation after revert, and fresh approval 10041 with reply 10042.

Those historical versions left the ticket open and used the earlier pending
provisioning wording. The revised final scope replaces that behavior with Done
and a request-approval result. Old Jira comments remain historical evidence.

The Done update passed 163 local tests, JavaScript lint, and Forge lint before
deployment. Local tests include another selected teammate, self approval,
missing fields, stale approvals, Closed-versus-Done selection, permissions,
uncertain responses, duplicate events, and reply recovery after Done.
Development version **4.3.0** deployed successfully on 2026-10-28; deployment
lint reported no issues. Existing manifest permissions are unchanged, so no
installation upgrade was required. Live verification of both the missing-field failure and successful Done behavior
has now passed, as recorded below.

Live missing-field verification passed on KAN-5: approval comment `10044`
matched the selected approver and logged `REQUEST_FIELDS_INVALID` /
`SITE_ID_REQUIRED` at `2026-10-28T16:08:40.300Z`. The bot posted corrective
comment `10045` at `16:08:40.893Z`. The Jira page independently showed the
missing Site ID, the plain-English corrective message, and status **To Do**.
No Done transition was attempted.

Live success verification passed for fresh approval comment `10046` after the
user restored Site ID to `DEMO-SITE`. The Jira page independently showed the
AccessAutomationBot reply: “Request approved. The selected approver and all
required details have been checked. This ticket is now Done.” The ticket’s
actual status was **Done**, not Closed. This confirms the installed bot can
transition this workflow and post the final result. Both final-scope paths are
verified live on KAN-5. Acceptance of another selected teammate and rejection
of self approval are covered by local tests; live tests used the current
human account with AccessAutomationBot as Reporter.
No external access was changed in any current test.

## Official references

- https://developer.atlassian.com/platform/forge/events-reference/jira/#comment-on-issue
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-get
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-post
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
- https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/#change-write-conflict-strategy
- https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/
- https://developer.atlassian.com/platform/forge/cli-reference/variables-set/
