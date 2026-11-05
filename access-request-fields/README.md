# Access Request conditional fields

A Forge UI modifications app for the existing global **+ Create** window in Jira.
It uses existing fields; it does not add a separate request form.

## Target

- Site: chelsiasworkspace-41902378.atlassian.net
- Space: Jira Access Automation (KAN), project ID `10000`
- Work type: Access Request, ID `10009`
- View: global Create (`GIC`) only
- App ID: `f4911abc-a701-4650-b1ed-ba700b0d6bf5`

## Form behaviour

| Access Type | Visible and required fields |
| --- | --- |
| No selection | None of the four conditional fields |
| Account Access | Account ID and Site ID |
| Role Access | Role Access (Team Member, Super User, Read Only) |
| Platform Access | Platform Access (EC2, AWS, Snowflake) |

The dropdown choices already exist in Jira. This app controls visibility and
required status only. Switching Access Type clears values in inactive branches,
because Jira otherwise submits hidden field values. Summary, Description,
Assignee, Reporter, Approver, Category, and Component retain their native behaviour.

All four conditional fields must remain **optional** in the base work type
configuration. Jira does not let UI modifications undo a globally required field.

## Files

- `src/config.mjs`: existing Jira project/type/field IDs.
- `static/hello-world/src/rules.mjs`: initial display and Access Type changes.
- `static/hello-world/src/index.js`: registers the field-rule callbacks.
- `src/registration.mjs`: verifies the target and creates/updates one exact context.
- `src/index.js`: calls Jira APIs after app installation or upgrade.
- `manifest.yml`: modules, permissions, resources, and the registered app ID.

The app's installation handler runs without a user, using `asApp` to register its
own UI behaviour. It checks the expected project and work type before activation.
It does not grant access, create tickets, or change Jira field definitions.

## Permissions

Atlassian requires the full classic scope group for UI modifications:
`read:jira-user`, `read:jira-work`, `manage:jira-configuration`, `write:jira-work`,
and `manage:jira-project`. The app also declares `read:app-data:jira` and
`write:app-data:jira` for its own UI modification registrations, as recommended by
the REST API. These platform permissions are broader than the exact Create context
registered by the app. No external network destinations are configured.

## Build and validate

Use Node.js 24.22.1 or a newer supported Node 24 patch and Forge CLI 15.
Run these in the app root:

```sh
npm ci
npm --prefix static/hello-world ci
npm test
npm run build
forge lint --environment development
```

The frontend uses a small esbuild bundle and no separate React form.
Both dependency sets have lockfiles. Tokens are stored by Forge's normal login
mechanism; do not put credentials in this source tree.

## Deploy and install

After lint passes, run these from the app root:

```sh
forge deploy --non-interactive --environment development
forge install --non-interactive --site chelsiasworkspace-41902378.atlassian.net --product Jira --environment development --confirm-scopes
```

The final command confirms the scopes listed above and installs the app on the
specified site. For an existing installation after adding permissions, add
`--upgrade`. If deployment requests additional consent, review that prompt.
Do not skip validation with `--no-verify`.

After installation, inspect `forge logs --environment development --since 15m`
for the registration result. Reopen Jira's global Create window and select KAN /
Access Request. Verify all three branches and the empty selection; confirm the
native fields stay present. Switching to Task should leave its form unaffected.
Use a draft for this check; no test ticket is necessary. Hide/show rules can take
a moment to load after opening the form.

If registration fails, inspect the recorded HTTP status and target IDs. Do not
broaden the context to a wildcard. The install/upgrade handler reuses an existing
registration with the same name rather than creating duplicates.

## Disable

To remove the app, use `forge uninstall`, reviewing the prompts. Existing Jira
fields and tickets remain.

## Phase 1 validation

- 13 local tests passed: branch visibility/required status, stale-value clearing,
  unrelated changes, exact registration scope, target mismatch, pagination/update,
  and HTTP failure handling.
- Frontend build completed.
- Root and frontend npm dependency audits reported 0 vulnerabilities.
- Forge lint passed in the user terminal and again during deployment.
- Deployed development version 2.0.0 on 2026-10-27.
- The user explicitly approved the complete permission list. Installation of
  development version 2 completed on the intended Jira site on 2026-10-27.
- Forge install list reports installation `49b3127f-db1f-4df0-aac3-9d4bf9771797`
  as Up-to-date.
- The lifecycle log at 2026-10-27T11:02:27.223Z confirms:
  `Access Request conditional fields created; KAN/10009/GIC.`
- The user subsequently confirmed the live conditional fields and reordered layout work correctly. Phase 1 is verified.

## Scope

This app only controls the conditional fields in Jira's existing global Create
window. Approval processing, provisioning, service-account comments, queues,
storage, and automatic ticket closure have been removed from this codebase.
The corresponding demo tests and dependencies have also been removed.

The existing Approver field remains a native Jira field. Choosing an approver or
posting a Grant access comment does not run any approval automation in this app.
The completed Phase 2 will be built separately, in a new folder, step by step.

## Official references

- https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-ui-modifications/
- https://developer.atlassian.com/platform/forge/apis-reference/jira-api-bridge/uiModifications/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-ui-modifications--apps-/

## Cleanup verification

Cleanup completed on 2026-10-27:

- Removed all six `src/demo/` modules and both demo test files.
- Removed the Jira comment trigger, queue consumer, demo functions, `storage:app`,
  and backend egress permission. Removed `@forge/events` and `@forge/kvs`.
- Removed development variables `DEMO_ENABLED`, `DEMO_CREATE_FIXTURES`,
  `DEMO_APPROVER_ACCOUNT_IDS`, and the encrypted `DEMO_SERVICE_TOKEN` without
  reading its value.
- All 13 remaining Phase 1 tests, frontend build, and Forge lint passed.
- Deployed development version **4.0.0** and upgraded the existing installation
  on the intended Jira site. Forge reports major version 4 as Up-to-date.
- The conditional field rules and target IDs were preserved unchanged.

Existing Jira tickets, comments, fields, workflow, and the service account were
not deleted. Removing the encrypted variable does not revoke the API token in
Atlassian Administration. No new Phase 2 app has been created.
