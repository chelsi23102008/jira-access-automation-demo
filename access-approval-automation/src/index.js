import api, { fetch, route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { checkApproval, readJira } from './process.mjs';
import { TARGET } from './approval.mjs';
import { createApprovalStore } from './records.mjs';
import { createBotClient } from './bot.mjs';
import { acknowledgeApproval, createNoticeStore } from './notices.mjs';
import { REQUEST_FIELDS } from './request.mjs';
import { readCompleteHistory } from './binding.mjs';
import { createBindingStore } from './binding-store.mjs';
import { checkRequestUpdate } from './updates.mjs';
import { completePhase2, createCompletionStore } from './completion.mjs';

// Jira event handlers have no signed-in UI user. Fetch current records with
// the app's read permission, then check the actual author and approver.
export async function run(event) {
  const jira = api.asApp();
  const fields = ['project', 'issuetype', 'status', 'reporter', 'summary', 'description', 'updated','labels',
    TARGET.approverField, ...Object.values(REQUEST_FIELDS)].join(',');
  const headers = { Accept: 'application/json' };
  const client = {
    async getIssue(issueId) {
      return readJira(await jira.requestJira(
        route`/rest/api/3/issue/${issueId}?fields=${fields}`, { headers }
      ), 'Read access request');
    },
    async getComment(issueId, commentId) {
      return readJira(await jira.requestJira(
        route`/rest/api/3/issue/${issueId}/comment/${commentId}`, { headers }
      ), 'Read approval comment');
    },
    async getHistory(issueId) {
      return readCompleteHistory(async startAt => readJira(await jira.requestJira(
        route`/rest/api/3/issue/${issueId}/changelog?startAt=${startAt}&maxResults=100`, { headers }
      ), 'Read approval history'));
    }
  };
  const bindings = createBindingStore(kvs, WhereConditions.beginsWith);
  const bot = createBotClient({ fetch, token: process.env.BOT_API_TOKEN });
  if (event?.eventType === 'avi:jira:updated:issue') return checkRequestUpdate(event, {
    client, bindings,
    notify: (record, comment, binding) => acknowledgeApproval(record, comment, {
      bot, client, bindings, binding, delivery: createNoticeStore(kvs, 'approval-change-notice:v1')
    })
  });
  return checkApproval(event, {
    client, bindings, store: createApprovalStore(kvs),
    complete: (command, options = {}) => completePhase2(command, {
      client, bindings, bot, completionStore: createCompletionStore(kvs), ...options
    }),
    reject: (command, comment, rejectionCode) => acknowledgeApproval(command, comment, {
      bot,  client, delivery: createNoticeStore(kvs), rejectionCode
    }),
    acknowledge: (command, comment, validation, binding, completion) => acknowledgeApproval(command, comment, {
      bot, client, delivery: createNoticeStore(kvs), validation, binding, completion
    })
  });
}
