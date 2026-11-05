# Jira Access Automation — Demo

This repository contains the two separate Forge apps used for the personal Jira demo. It does not contain the migration app.

## Apps

| Folder | Purpose |
| --- | --- |
| [access-request-fields](access-request-fields/) | Phase 1: conditional fields in Jira's existing global **+ Create** window |
| [access-approval-automation](access-approval-automation/) | Phase 2: validate an approval comment, record approval evidence, post the bot result, and move successful requests to **Done** |

Each folder is a separate Forge app with its own manifest, registered app identity, dependencies, and commands. Run app commands from the relevant app folder.

## What the demo does

Phase 1 uses the selected Access Type to show and require the relevant existing Jira fields:

- **Account Access:** Account ID and Site ID.
- **Role Access:** Team Member, Super User, or Read Only.
- **Platform Access:** EC2, AWS, or Snowflake.

Phase 2 processes a new, unedited plain-text **Grant access** comment on an eligible ticket carrying the exact label `access-automation`. It verifies the selected approver, rejects self-approval and the configured bot, validates the relevant request fields, saves approval evidence, and checks for changes after approval. A confirmed successful transition to Done produces the AccessAutomationBot success comment. Failures produce a corrective explanation when comment delivery is possible.

Removing the opt-in label invalidates an existing bound approval and allows one explanatory notice. Adding the label back does not restore that approval. Tickets without the label remain outside ordinary automatic processing.

**No real external access is provisioned.** A success means the Jira approval workflow completed, not that access to AWS, Snowflake, an account, or a site was granted.

## Demo configuration

These apps retain the existing personal-demo configuration for project KAN (project ID `10000`) and work type Access Request (ID `10009`). Phase 1 controls only the global Create view. The Phase 2 bot/site identifiers and field mappings are demo-specific.

The manifests retain the existing Forge app IDs. Cloning or moving this repository does not create new Forge app identities. These sources are a demo snapshot, not the configurable migration version.

## Credentials and local files

The Phase 2 service-account token belongs in the encrypted Forge variable `BOT_API_TOKEN`; its value must never be committed. Dependency folders, generated frontend output, Forge local state, environment files, editor files, and backup files are ignored.

The checked-in site, field, app, and bot identifiers are configuration identifiers, not API credentials. Access to Jira still requires the relevant installation, authentication, and permissions.

## Validation snapshot — 2026-11-05

The first repository snapshot preserves the existing application and test code, including two known test-file problems:

| Check | Observed result |
| --- | --- |
| Phase 1 full test command | 13 passed; one obsolete `test/demo.test.mjs` file fails to load because it imports removed `src/demo/` modules |
| Phase 2 full test command | 161 passed; `test/completion.test.mjs` fails during module evaluation because of a stray standalone `c` at the end |
| Phase 2 JavaScript source lint | Passed |

A failing test module does not establish that its declared test cases passed. These issues require cleanup before claiming a passing full suite. Older verification sections inside the individual app READMEs are historical and may refer to earlier deployments.

## Limits and production status

This is a working approval-workflow demo, not an approved production access-provisioning system.

- Atomic guards are per comment; there is no ticket-wide lock or global exactly-once guarantee.
- Jira changes and Forge storage writes do not form one transaction.
- Uncertain writes and abandoned processing guards can require manual review; there is no scheduled recovery queue.
- The demo does not positively verify every missing approver activity/account-type value.
- The demo reply path copies previously read source-comment visibility without the additional final visibility checks implemented separately in the migration app.
- Bot requests have no explicit application timeout/backoff policy.
- Production workload testing, company-site acceptance, retention/deletion procedures, and operational support readiness have not been established by this demo.

## Local commands

Use the supported Node 24 toolchain and the app-specific instructions in each folder.

### Phase 1

```sh
cd access-request-fields
npm ci
npm --prefix static/hello-world ci
node --test test/registration.test.mjs test/rules.test.mjs
npm run build
```

The targeted command runs the 13 current Phase 1 tests. The full `npm test` command also includes the obsolete test file described above.

### Phase 2

```sh
cd access-approval-automation
npm ci
npm run lint
npm test
```

The full test command currently has the test-module problem described above. Deployment is a separate, deliberate action; uploading this repository does not deploy either app.
