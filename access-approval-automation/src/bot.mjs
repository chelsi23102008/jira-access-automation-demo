import { Buffer } from 'node:buffer';

// This app is intentionally installed on one site. Keep the API destination
// fixed: a ticket or comment must never control where credentials are sent.
export const BOT = Object.freeze({
  cloudId: 'f75adfdc-b3de-42a6-b094-31eb9bae926d',
  email: 'accessautomationbot-v81xin7orf@serviceaccount.atlassian.com',
  accountId: '712020:66952b5c-6f6f-4eae-9113-1c52b249fa16'
});

export const BOT_MESSAGES = Object.freeze({
  BOT_TOKEN_MISSING: 'The bot API token is not configured.',
  BOT_AUTH_FAILED: 'The bot API token was rejected. It may be expired or invalid.',
  BOT_PERMISSION_DENIED: 'The bot does not have the required token scope or Jira permission.',
  BOT_RECORD_NOT_FOUND: 'The bot cannot find or view the requested Jira record.',
  BOT_RATE_LIMITED: 'Jira temporarily limited the bot requests.',
  BOT_IDENTITY_MISMATCH: 'The token does not belong to the configured AccessAutomationBot account.',
  BOT_CONNECTION_FAILED: 'The connection to Jira failed. Comment delivery could not be confirmed.',
  BOT_RESPONSE_INVALID: 'Jira returned an unexpected response. Comment delivery could not be confirmed.',
  BOT_REQUEST_FAILED: 'Jira rejected the bot request.',
  NOTICE_STORAGE_FAILED: 'The comment delivery record could not be saved or checked.'
});

export function botError(code) {
  return Object.assign(new Error(BOT_MESSAGES[code]), { code });
}

function numericId(id) {
  if (!/^\d+$/.test(String(id))) throw botError('BOT_RESPONSE_INVALID');
  return String(id);
}

// Keep this injectable so tests never need an actual API token or network.
// Authentication is checked lazily; ordinary comments do not use the bot token.
export function createBotClient({ fetch, token }) {
  async function request(path, { method = 'GET', body, expectedStatus = 200 } = {}) {
    if (!token?.trim()) throw botError('BOT_TOKEN_MISSING');
    let response;
    try {
      response = await fetch(`https://api.atlassian.com/ex/jira/${BOT.cloudId}/rest/api/3/${path}`, {
        method,
        redirect: 'error', // Never forward the Authorization header to a redirect.
        headers: {
          Authorization: `Basic ${Buffer.from(`${BOT.email}:${token.trim()}`).toString('base64')}`,
          Accept: 'application/json', 'Content-Type': 'application/json',
          'Accept-Language': 'en-US', 'X-Force-Accept-Language': 'true'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw botError('BOT_CONNECTION_FAILED'); }
    const statusCodes = { 401: 'BOT_AUTH_FAILED', 403: 'BOT_PERMISSION_DENIED',
      404: 'BOT_RECORD_NOT_FOUND', 429: 'BOT_RATE_LIMITED' };
    if (response.status !== expectedStatus) {
      // Do not read error bodies: they may echo private request information.
      throw botError(statusCodes[response.status] ?? 'BOT_REQUEST_FAILED');
    }
    if (expectedStatus === 204) return;
    try { return await response.json(); } catch { throw botError('BOT_RESPONSE_INVALID'); }
  }

  return {
    async verifyIdentity() {
      const user = await request('myself');
      if (user?.accountId !== BOT.accountId || user.active !== true) {
        throw botError('BOT_IDENTITY_MISMATCH');
      }
    },
    async postComment(issueId, payload) {
      const result = await request(`issue/${numericId(issueId)}/comment`, {
        method: 'POST', body: payload, expectedStatus: 201
      });
      if (result?.author?.accountId !== BOT.accountId) throw botError('BOT_RESPONSE_INVALID');
      return numericId(result.id);
    },
    async getComment(issueId, commentId) {
      return request(`issue/${numericId(issueId)}/comment/${numericId(commentId)}`);
    },
    async getTransitions(issueId) {
      const result = await request(`issue/${numericId(issueId)}/transitions`);
      if (!Array.isArray(result?.transitions)) throw botError('BOT_RESPONSE_INVALID');
      return result.transitions;
    },
    async transition(issueId, transitionId) {
      await request(`issue/${numericId(issueId)}/transitions`, {
        method: 'POST', body: { transition: { id: numericId(transitionId) } }, expectedStatus: 204
      });
    },
    async getStatus(issueId) {
      const result = await request(`issue/${numericId(issueId)}?fields=status`);
      if (String(result?.id) !== String(issueId) || !result.fields?.status?.id) throw botError('BOT_RESPONSE_INVALID');
      return result.fields.status;
    }
  };
}
