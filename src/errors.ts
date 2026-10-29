import { KanbioApiError, NETWORK_ERROR } from './client.js';
import { STATUS_LABELS, Status, TRANSITIONS, WORKFLOW_TEXT, ToolInputError } from './kanbio.js';

const CREATE_TOKEN_HINT =
  'The user can create one in Kanbio (sidebar → "Conectar con IA") and put it in KANBIO_TOKEN.';

/** Scopes as the "Conectar con IA" screen names them, for the hints. */
const SCOPE_NAMES: Record<string, string> = {
  'tickets:read': 'read tickets',
  'comments:write': 'comment',
  'tickets:create': 'create tickets',
  'tickets:edit': 'edit tickets',
  'tickets:status': 'change the status',
  'tickets:assign': 'assign tickets',
  'sprints:write': 'plan sprints',
};

/**
 * Turns any failure into a sentence an AI can act on (and repeat to the
 * user): what went wrong and what would fix it. Never includes the token.
 */
export function describeError(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (!(error instanceof KanbioApiError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const message = error.apiMessage;
  switch (error.status) {
    case NETWORK_ERROR:
      return `${message}. Check KANBIO_API_URL and that Kanbio is up.`;
    case 401:
      return `Kanbio rejected the token: it is wrong, expired or revoked. ${CREATE_TOKEN_HINT}`;
    case 403: {
      const missing = /lacks the permission: (.+)$/.exec(message);
      if (missing) {
        const scopes = missing[1].split(',').map((s) => s.trim());
        const names = scopes.map((s) => `${s} (${SCOPE_NAMES[s] ?? s})`).join(', ');
        return `Permission denied (403): this token lacks the permission ${names}. Do not retry; tell the user. To allow it they must create a "Personalizado" token with that permission in Kanbio (sidebar → "Conectar con IA").`;
      }
      if (/not available to API tokens/.test(message)) {
        return 'Permission denied (403): Kanbio does not allow this action through an API token. The user has to do it in the web app.';
      }
      if (/PM permissions/.test(message)) {
        return 'Permission denied (403): only a PM of this project (or a superadmin) can do this, and the token never does more than its owner.';
      }
      if (/access to this project/.test(message)) {
        return 'Permission denied (403): the token (or its owner) has no access to this project. Tokens can be limited to some projects.';
      }
      return `Permission denied (403): ${message}`;
    }
    case 404:
      return `Not found (404): ${message}.`;
    case 409:
      return `Conflict (409): ${message}.`;
    case 429:
      return 'Kanbio is rate limiting this token (429). Wait a minute and try again.';
    case 400: {
      const transition = /Invalid status transition: (\w+) → (\w+)/.exec(message);
      if (transition) {
        const from = transition[1] as Status;
        const to = transition[2] as Status;
        const allowed = (TRANSITIONS[from] ?? []).map((s) => `${STATUS_LABELS[s]} (${s})`);
        return `Kanbio does not allow moving a ticket from ${STATUS_LABELS[from] ?? from} to ${STATUS_LABELS[to] ?? to}. From ${STATUS_LABELS[from] ?? from} it can go to: ${allowed.join(', ') || 'nothing'}. Workflow: ${WORKFLOW_TEXT}`;
      }
      const details = error.details.length > 0 ? ` (${error.details.join('; ')})` : '';
      return `Kanbio rejected the request (400): ${message}${details}.`;
    }
    default:
      return `Kanbio answered ${error.status}: ${message}.`;
  }
}
