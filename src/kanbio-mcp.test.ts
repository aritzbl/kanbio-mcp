import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KanbioApiError, KanbioClient, NETWORK_ERROR, readConfig } from './client.js';
import { describeError } from './errors.js';
import { readableText, withMentions } from './format.js';
import {
  findState,
  Kanbio,
  matchPeople,
  Member,
  Project,
  Subtask,
  Ticket,
  ToolInputError,
  Workflow,
  WorkflowState,
} from './kanbio.js';
import { registerTools } from './tools.js';

const ana: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ana@example.test',
  firstName: 'Ana',
  lastName: 'Pérez',
  displayName: 'Ana Pérez',
  role: 'dev',
};
const andres: Member = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'andres@example.test',
  firstName: 'Andrés',
  lastName: 'Gómez',
  displayName: '',
  role: 'qa',
};

describe('API errors as messages for the AI', () => {
  it('names the missing permission and says not to retry', () => {
    const message = describeError(
      new KanbioApiError(403, 'This API token lacks the permission: tickets:status'),
    );
    assert.match(message, /tickets:status \(change the status\)/);
    assert.match(message, /Do not retry/);
    assert.match(message, /Conectar con IA/);
  });

  it('explains an invalid transition with the states the API allows', () => {
    const message = describeError(
      new KanbioApiError(400, 'Invalid status transition: Nuevo → Resuelto', [], 'INVALID_TRANSITION', {
        from: 'Nuevo',
        to: 'Resuelto',
        allowed: ['Triage'],
      }),
    );
    assert.match(message, /from Nuevo to Resuelto/);
    assert.match(message, /From Nuevo it can go to: Triage\./);
    const stuck = describeError(
      new KanbioApiError(400, 'Invalid status transition: Cerrado → Nuevo', [], 'INVALID_TRANSITION', {
        from: 'Cerrado',
        to: 'Nuevo',
        allowed: [],
      }),
    );
    assert.match(stuck, /From Cerrado it can go to: nothing/);
  });

  it('lists the states of the project for an unknown state', () => {
    const message = describeError(
      new KanbioApiError(400, 'Unknown status "Doing" for this project', [], 'UNKNOWN_STATE', {
        status: 'Doing',
        states: ['To Do', 'In Progress', 'Done'],
      }),
    );
    assert.equal(message, 'The project has no state "Doing". Its states: To Do, In Progress, Done.');
  });

  it('still explains a transition message without a code', () => {
    const message = describeError(
      new KanbioApiError(400, 'Invalid status transition: To Do → Esperando cliente'),
    );
    assert.match(message, /from To Do to Esperando cliente\. get_ticket shows where it can move/);
  });

  it('explains the subtask error codes', () => {
    const say = (code: string) => describeError(new KanbioApiError(400, 'x', [], code));
    assert.match(say('PARENT_IS_SELF'), /own parent/);
    assert.match(say('PARENT_NOT_FOUND'), /same project as its parent/);
    assert.match(say('PARENT_IS_SUBTASK'), /itself a subtask.*one level/);
    assert.match(say('TICKET_HAS_SUBTASKS'), /cannot become a subtask/);
  });

  it('covers expired tokens, missing tickets, rate limits and the network', () => {
    assert.match(describeError(new KanbioApiError(401, 'Invalid API token')), /expired or revoked/);
    assert.match(describeError(new KanbioApiError(404, 'Ticket not found')), /Not found \(404\)/);
    assert.match(describeError(new KanbioApiError(429, 'ThrottlerException')), /Wait a minute/);
    assert.match(
      describeError(new KanbioApiError(NETWORK_ERROR, 'Could not reach Kanbio at http://x/api (fetch failed)')),
      /Check KANBIO_API_URL/,
    );
    assert.match(
      describeError(new KanbioApiError(403, 'You need PM permissions in this project')),
      /only a PM/,
    );
    assert.match(
      describeError(new KanbioApiError(400, 'Validation failed', ['title: Required'])),
      /title: Required/,
    );
    assert.equal(describeError(new ToolInputError('No project "X".')), 'No project "X".');
  });
});

describe('Mentions', () => {
  it('turns @Name into a mention and mentions the rest at the start', () => {
    const content = withMentions('Hola @ana pérez, ¿lo revisás?', [ana, andres]);
    assert.equal(
      content,
      `@[Andrés Gómez](user:${andres.id}) Hola @[Ana Pérez](user:${ana.id}), ¿lo revisás?`,
    );
    assert.equal(readableText(content), '@Andrés Gómez Hola @Ana Pérez, ¿lo revisás?');
  });

  it('shows attachments as file names', () => {
    assert.equal(
      readableText('Ver ![log.txt](attachment:33333333-3333-4333-8333-333333333333)'),
      'Ver [file: log.txt]',
    );
  });

  it('finds people by email, full name or part of it, ignoring accents', () => {
    assert.deepEqual(matchPeople([ana, andres], 'ANA@example.test'), [ana]);
    assert.deepEqual(matchPeople([ana, andres], 'andres gomez'), [andres]);
    assert.deepEqual(matchPeople([ana, andres], '@Pérez'), [ana]);
    assert.equal(matchPeople([ana, andres], 'an').length, 2);
    assert.deepEqual(matchPeople([ana, andres], 'zoe'), []);
  });
});

describe('Configuration', () => {
  it('accepts the URL with or without /api', () => {
    const token = `kbn_${'a'.repeat(43)}`;
    const plain = readConfig({ KANBIO_API_URL: 'https://kanbio.example.com/', KANBIO_TOKEN: token });
    assert.equal(plain.config?.apiUrl, 'https://kanbio.example.com/api');
    const withApi = readConfig({ KANBIO_API_URL: 'http://localhost:4000/api', KANBIO_TOKEN: token });
    assert.equal(withApi.config?.apiUrl, 'http://localhost:4000/api');
  });

  it('explains what is missing instead of crashing', () => {
    const result = readConfig({ KANBIO_TOKEN: 'secret' });
    assert.equal(result.config, null);
    assert.equal(result.problems.length, 2);
    assert.match(result.problems.join(' '), /KANBIO_API_URL is not set/);
    assert.match(result.problems.join(' '), /start with "kbn_"/);
    assert.ok(!result.problems.join(' ').includes('secret'));
  });
});

// ---- Per-project workflows, through the tools, with a fake API ----

function state(id: string, name: string, position: number, extra: Partial<WorkflowState> = {}): WorkflowState {
  return { id, name, position, color: 'gray', isDone: false, notifiesQa: false, legacyKey: null, ...extra };
}

function moves(...pairs: [string, string][]): Workflow['transitions'] {
  return pairs.map(([fromStateId, toStateId]) => ({ fromStateId, toStateId }));
}

/** A custom template, as in the "E2E Soporte" projects. */
const support: Workflow = {
  templateId: 'tpl-support',
  name: 'Soporte',
  states: [
    state('s-new', 'Nuevo', 0),
    state('s-triage', 'Triage', 1),
    state('s-doing', 'En curso', 2),
    state('s-waiting', 'Esperando cliente', 3),
    state('s-solved', 'Resuelto', 4, { isDone: true }),
    state('s-closed', 'Cerrado', 5, { isDone: true }),
  ],
  transitions: moves(
    ['s-new', 's-triage'],
    ['s-triage', 's-doing'],
    ['s-triage', 's-closed'],
    ['s-doing', 's-waiting'],
    ['s-doing', 's-solved'],
    ['s-waiting', 's-doing'],
    ['s-solved', 's-closed'],
    ['s-solved', 's-doing'],
  ),
};

/** The default "Kanbio clásico" template, with the old status keys. */
const classic: Workflow = {
  templateId: 'tpl-classic',
  name: 'Kanbio clásico',
  states: [
    state('c-todo', 'To Do', 0, { legacyKey: 'todo' }),
    state('c-doing', 'In Progress', 1, { legacyKey: 'in_progress' }),
    state('c-merge', 'To Merge', 2, { legacyKey: 'to_merge' }),
    state('c-qa', 'To Test', 3, { legacyKey: 'qa', notifiesQa: true }),
    state('c-done', 'Done', 4, { legacyKey: 'done', isDone: true }),
    state('c-rejected', 'Rejected', 5, { legacyKey: 'rejected', isDone: true }),
  ],
  transitions: moves(
    ['c-todo', 'c-doing'],
    ['c-doing', 'c-merge'],
    ['c-doing', 'c-qa'],
    ['c-merge', 'c-qa'],
    ['c-qa', 'c-done'],
    ['c-qa', 'c-rejected'],
    ['c-done', 'c-qa'],
    ['c-done', 'c-doing'],
    ['c-rejected', 'c-qa'],
    ['c-rejected', 'c-doing'],
  ),
};

const projects: Project[] = [
  { id: 'p-sup', key: 'SUP', name: 'E2E Soporte', description: null, myRole: 'dev' },
  { id: 'p-cls', key: 'CLS', name: 'E2E Clásico', description: null, myRole: 'dev' },
];
const workflows: Record<string, Workflow> = { 'p-sup': support, 'p-cls': classic };

function ticket(id: string, key: string, projectId: string, stateId: string): Ticket {
  const name = workflows[projectId].states.find((s) => s.id === stateId)!.name;
  return {
    id,
    projectId,
    key,
    title: `Ticket ${key}`,
    description: null,
    type: 'task',
    priority: 'medium',
    storyPoints: null,
    stateId,
    status: name,
    reporterId: ana.id,
    assigneeId: ana.id,
    sprintId: null,
    epicId: null,
    labels: [],
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
  };
}

/** A subtask of SUP-3 as the detail route lists it. */
function subtask(id: string, key: string, extra: Partial<Subtask> = {}): Subtask {
  return {
    id,
    key,
    title: `Ticket ${key}`,
    type: 'task',
    priority: 'medium',
    stateId: 's-doing',
    status: 'En curso',
    isDone: false,
    assigneeId: ana.id,
    sprintId: 'sp-1',
    epicId: null,
    ...extra,
  };
}

interface Call {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/** What the API answers when a sprint is created: numbered, active, no goal. */
const newSprint = {
  id: 'sp-3',
  name: 'Sprint 3',
  goal: null,
  status: 'active',
  startDate: '2026-11-17T03:00:00.000Z',
  endDate: '2026-11-30T03:00:00.000Z',
};

/** Answers like the Kanbio API for a few tickets and records every call. */
class FakeApi {
  calls: Call[] = [];
  /** When set, PATCH fails with it. */
  patchError: KanbioApiError | null = null;
  tickets = [
    ticket('t-1', 'SUP-1', 'p-sup', 's-triage'),
    ticket('t-2', 'SUP-2', 'p-sup', 's-closed'),
    ticket('t-3', 'CLS-1', 'p-cls', 'c-doing'),
    // SUP-3 is a parent in Sprint 1 with 2 subtasks (SUP-4 open and in the backlog, SUP-5 done).
    {
      ...ticket('t-4', 'SUP-3', 'p-sup', 's-doing'),
      sprintId: 'sp-1',
      subtaskProgress: { total: 2, done: 1 },
      subtasks: [
        subtask('t-5', 'SUP-4', { sprintId: null }),
        subtask('t-6', 'SUP-5', { stateId: 's-solved', status: 'Resuelto', isDone: true }),
      ],
    },
    {
      ...ticket('t-5', 'SUP-4', 'p-sup', 's-doing'),
      parentId: 't-4',
      parent: {
        id: 't-4',
        key: 'SUP-3',
        title: 'Ticket SUP-3',
        type: 'task',
        stateId: 's-doing',
        status: 'En curso',
        sprintId: 'sp-1',
      },
      subtaskProgress: { total: 0, done: 0 },
    },
  ];

  async get(path: string, query?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'GET', path, query });
    if (path === '/projects') return projects;
    if (path === '/users/me') return ana;
    if (path === '/tickets/search') return { items: this.tickets, total: this.tickets.length };
    const byKey = /^\/tickets\/by-key\/(.+)$/.exec(path);
    if (byKey) {
      const wanted = decodeURIComponent(byKey[1]).toUpperCase();
      const found = this.tickets.find((t) => t.key === wanted);
      if (!found) throw new KanbioApiError(404, 'Ticket not found');
      return found;
    }
    const project = /^\/projects\/([^/]+)\/(\w+)$/.exec(path);
    if (project?.[2] === 'workflow') return workflows[project[1]];
    if (project?.[2] === 'members') return { items: [ana], totalPages: 1 };
    if (project?.[2] === 'sprints') {
      return project[1] === 'p-sup'
        ? [{ id: 'sp-1', name: 'Sprint 1', goal: null, status: 'active', startDate: null, endDate: null }]
        : [];
    }
    if (/^\/tickets\/[^/]+\/comments$/.test(path)) return [];
    throw new Error(`Unexpected GET ${path}`);
  }

  async patch(path: string, body: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'PATCH', path, body });
    if (this.patchError) throw this.patchError;
    if (path.startsWith('/sprints/')) return { ...newSprint, ...body };
    const found = this.tickets.find((t) => path === `/tickets/${t.id}`)!;
    const target = workflows[found.projectId].states.find((s) => s.id === body.stateId);
    return target ? { ...found, stateId: target.id, status: target.name } : found;
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'POST', path, body });
    if (/^\/projects\/[^/]+\/sprints$/.test(path)) return newSprint;
    if (path === '/projects/p-sup/tickets') {
      // Like the API: a subtask inherits the sprint of its parent when none is sent.
      const parent = this.tickets.find((t) => t.id === body.parentId);
      const sprintId = 'sprintId' in body ? body.sprintId : (parent?.sprintId ?? null);
      return { ...ticket('t-new', 'SUP-9', 'p-sup', 's-new'), title: String(body.title), sprintId };
    }
    throw new Error(`Unexpected POST ${path}`);
  }

  writes(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  patches(): Call[] {
    return this.calls.filter((call) => call.method === 'PATCH');
  }

  lastSearch(): Record<string, unknown> | undefined {
    return this.calls.filter((call) => call.path === '/tickets/search').at(-1)?.query;
  }
}

describe('Per-project workflows', () => {
  let api: FakeApi;
  let client: Client;

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join('\n'), isError: result.isError === true };
  }

  before(async () => {
    api = new FakeApi();
    const server = new McpServer({ name: 'kanbio', version: 'test' });
    registerTools(server, new Kanbio(api as unknown as KanbioClient));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  beforeEach(() => {
    api.calls = [];
    api.patchError = null;
  });

  after(() => client.close());

  it('finds a state by name, old key or id, ignoring case and accents', () => {
    assert.equal(findState(support, '  en CURSO ')?.id, 's-doing');
    assert.equal(findState(support, 'esperando cliente')?.id, 's-waiting');
    assert.equal(findState(classic, 'qa')?.id, 'c-qa');
    assert.equal(findState(classic, 'c-done')?.name, 'Done');
    assert.equal(findState({ ...support, states: [state('x', 'Revisión', 0)] }, 'revision')?.id, 'x');
    assert.equal(findState(support, 'qa'), undefined);
    assert.equal(findState(support, 'Doing'), undefined);
  });

  it('change_status resolves the name to a stateId', async () => {
    const result = await call('change_status', { key: 'sup-1', status: 'en CURSO' });
    assert.equal(result.isError, false);
    assert.equal(result.text, 'SUP-1: Triage → En curso. From there it can move to: Esperando cliente, Resuelto.');
    assert.deepEqual(api.patches(), [{ method: 'PATCH', path: '/tickets/t-1', body: { stateId: 's-doing' } }]);
  });

  it('change_status still takes old keys in classic projects', async () => {
    const result = await call('change_status', { key: 'CLS-1', status: 'qa' });
    assert.equal(result.text, 'CLS-1: In Progress → To Test. From there it can move to: Done, Rejected.');
    assert.deepEqual(api.patches()[0].body, { stateId: 'c-qa' });
  });

  it('change_status lists the states of the project for an unknown name', async () => {
    const result = await call('change_status', { key: 'SUP-1', status: 'Doing' });
    assert.equal(result.isError, true);
    assert.equal(
      result.text,
      'SUP has no state "Doing". Its states: Nuevo, Triage, En curso, Esperando cliente, Resuelto, Cerrado. From Triage, SUP-1 can move to: En curso, Cerrado.',
    );
    assert.equal(api.patches().length, 0);
  });

  it('change_status does nothing when the ticket is already there', async () => {
    const result = await call('change_status', { key: 'SUP-1', status: 'TRIAGE' });
    assert.equal(result.text, 'SUP-1 is already in Triage.');
    assert.equal(api.patches().length, 0);
  });

  it('change_status explains a move the API rejects', async () => {
    api.patchError = new KanbioApiError(
      400,
      'Invalid status transition: Triage → Resuelto',
      [],
      'INVALID_TRANSITION',
      { from: 'Triage', to: 'Resuelto', allowed: ['En curso', 'Cerrado'] },
    );
    const result = await call('change_status', { key: 'SUP-1', status: 'resuelto' });
    assert.equal(result.isError, true);
    assert.match(result.text, /from Triage to Resuelto\. From Triage it can go to: En curso, Cerrado\./);
  });

  it('get_ticket shows the status and where the ticket can move', async () => {
    const open = await call('get_ticket', { key: 'SUP-1' });
    assert.match(open.text, /^Status: Triage$/m);
    assert.match(open.text, /^Can move to: En curso, Cerrado$/m);
    const closed = await call('get_ticket', { key: 'SUP-2', include_comments: false });
    assert.match(closed.text, /^Status: Cerrado \(finished\)$/m);
    assert.match(closed.text, /^Can move to: nothing$/m);
  });

  it('search_tickets sends state names and the done filter', async () => {
    const result = await call('search_tickets', { status: ['To Test', 'en curso'], done: false });
    assert.match(result.text, /^SUP-1 · Triage · task/m);
    const query = api.lastSearch();
    assert.deepEqual(query?.status, ['To Test', 'en curso']);
    assert.equal(query?.done, false);
    await call('search_tickets', { done: true });
    assert.equal(api.lastSearch()?.done, true);
    assert.equal(api.lastSearch()?.status, undefined);
  });

  it('search_tickets in one project checks the names and searches by state id', async () => {
    await call('search_tickets', { project: 'sup', status: ['EN CURSO', 'nuevo'] });
    assert.deepEqual(api.lastSearch()?.stateId, ['s-doing', 's-new']);
    assert.equal(api.lastSearch()?.status, undefined);
    const unknown = await call('search_tickets', { project: 'SUP', status: ['To Test'] });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /SUP has no state "To Test"\. Its states: Nuevo, Triage/);
  });

  it('create_sprint sends the start of each day and reports the sprint', async () => {
    const result = await call('create_sprint', {
      project: 'sup',
      start_date: '2026-11-17',
      end_date: '2026-11-30',
    });
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Created Sprint 3 in SUP · active · 2026-11-17 → 2026-11-30.');
    assert.deepEqual(api.writes(), [
      {
        method: 'POST',
        path: '/projects/p-sup/sprints',
        body: {
          startDate: new Date('2026-11-17T00:00:00').toISOString(),
          endDate: new Date('2026-11-30T00:00:00').toISOString(),
        },
      },
    ]);
  });

  it('create_sprint saves the name and goal with a second call', async () => {
    const result = await call('create_sprint', {
      project: 'SUP',
      start_date: '2026-11-17',
      end_date: '2026-11-30',
      name: 'Release 2',
      goal: 'Cerrar la conciliación',
    });
    assert.equal(
      result.text,
      'Created Release 2 in SUP · active · 2026-11-17 → 2026-11-30 · goal: Cerrar la conciliación.',
    );
    assert.deepEqual(api.writes()[1], {
      method: 'PATCH',
      path: '/sprints/sp-3',
      body: { name: 'Release 2', goal: 'Cerrar la conciliación' },
    });
  });

  it('create_sprint rejects bad dates before calling the API', async () => {
    const backwards = await call('create_sprint', {
      project: 'SUP',
      start_date: '2026-11-30',
      end_date: '2026-11-17',
    });
    assert.equal(backwards.isError, true);
    assert.match(backwards.text, /end_date must not be before start_date/);
    const unreal = await call('create_sprint', {
      project: 'SUP',
      start_date: '2026-02-30',
      end_date: '2026-03-10',
    });
    assert.equal(unreal.isError, true);
    assert.equal(api.writes().length, 0);
  });

  it('get_ticket shows where the parent sits when the ticket is a subtask', async () => {
    const result = await call('get_ticket', { key: 'SUP-4', include_comments: false });
    assert.match(result.text, /^Parent: SUP-3 · En curso · "Ticket SUP-3" · Sprint 1$/m);
    assert.doesNotMatch(result.text, /Subtasks \(/);
  });

  it('get_ticket lists the subtasks of a parent and flags the open one outside its sprint', async () => {
    const result = await call('get_ticket', { key: 'SUP-3', include_comments: false });
    assert.match(result.text, /^Subtasks \(1\/2 done\):$/m);
    assert.match(
      result.text,
      /^- SUP-4 · En curso · "Ticket SUP-4" · Ana Pérez · backlog ⚠ open, outside the parent's sprint$/m,
    );
    // A done subtask, or one inside the sprint, carries no flag.
    assert.match(result.text, /^- SUP-5 · Resuelto · "Ticket SUP-5" · Ana Pérez · Sprint 1$/m);
    assert.doesNotMatch(result.text, /^Parent:/m);
  });

  it('get_ticket looks the same as before for a ticket from an older API', async () => {
    const result = await call('get_ticket', { key: 'SUP-1', include_comments: false });
    assert.doesNotMatch(result.text, /Parent:|Subtasks/);
  });

  it('lists mark a subtask with its parent and a parent with its progress', async () => {
    const result = await call('search_tickets', {});
    assert.match(result.text, /^SUP-3 · En curso .* · Sprint 1 · subtasks 1\/2$/m);
    assert.match(result.text, /^SUP-4 · En curso .* · backlog · ↳ SUP-3$/m);
    // No subtasks and no parent: the line ends as it always did.
    assert.match(result.text, /^SUP-1 · Triage · task · medium · "Ticket SUP-1" · Ana Pérez · backlog$/m);
    const mine = await call('my_tickets', {});
    assert.match(mine.text, /↳ SUP-3/);
  });

  it('create_ticket with a parent sends parentId and says what the subtask inherited', async () => {
    const result = await call('create_ticket', {
      project: 'SUP',
      title: 'Write tests',
      type: 'task',
      parent: 'sup-3',
    });
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Created SUP-9 as a subtask of SUP-3: "Write tests" (Nuevo, Sprint 1).');
    const post = api.writes()[0];
    assert.equal(post.path, '/projects/p-sup/tickets');
    assert.equal(post.body?.parentId, 't-4');
    assert.equal('sprintId' in (post.body ?? {}), false);
  });

  it('create_ticket with parent and sprint backlog sends sprintId null', async () => {
    await call('create_ticket', { project: 'SUP', title: 'Loose', type: 'task', parent: 'SUP-3', sprint: 'backlog' });
    assert.equal(api.writes()[0].body?.sprintId, null);
    assert.equal(api.writes()[0].body?.parentId, 't-4');
  });

  it('create_ticket rejects a parent from another project before calling the API', async () => {
    const result = await call('create_ticket', { project: 'SUP', title: 'X', type: 'task', parent: 'CLS-1' });
    assert.equal(result.isError, true);
    assert.equal(
      result.text,
      'CLS-1 is in CLS, not in SUP. A subtask must be in the same project as its parent.',
    );
    assert.equal(api.writes().length, 0);
  });

  it('create_ticket without a parent sends no parentId', async () => {
    await call('create_ticket', { project: 'SUP', title: 'Plain', type: 'task' });
    assert.equal('parentId' in (api.writes()[0].body ?? {}), false);
  });

  it('update_ticket links a parent by key and unlinks it with "none"', async () => {
    const link = await call('update_ticket', { key: 'SUP-1', parent: 'SUP-3' });
    assert.equal(link.text, 'SUP-1 updated (parent).');
    assert.deepEqual(api.patches()[0], { method: 'PATCH', path: '/tickets/t-1', body: { parentId: 't-4' } });
    await call('update_ticket', { key: 'SUP-4', parent: 'None' });
    assert.deepEqual(api.patches()[1].body, { parentId: null });
  });

  it('update_ticket rejects a parent from another project', async () => {
    const result = await call('update_ticket', { key: 'SUP-1', parent: 'CLS-1' });
    assert.equal(result.isError, true);
    assert.match(result.text, /same project as its parent/);
    assert.equal(api.patches().length, 0);
  });

  it('my_tickets asks for open tickets with done=false', async () => {
    await call('my_tickets', {});
    assert.equal(api.lastSearch()?.done, false);
    assert.equal(api.lastSearch()?.assigneeId, 'me');
    await call('my_tickets', { include_done: true });
    assert.equal(api.lastSearch()?.done, undefined);
  });
});

describe('Client', () => {
  it('keeps the error code and params the API sends', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          statusCode: 400,
          message: 'Invalid status transition: Nuevo → Cerrado',
          code: 'INVALID_TRANSITION',
          params: { from: 'Nuevo', to: 'Cerrado', allowed: ['Triage'] },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    try {
      const api = new KanbioClient({ apiUrl: 'http://kanbio.test/api', token: 'kbn_x' }, 'test');
      const error = await api.patch('/tickets/t-1', { stateId: 's-closed' }).catch((e: unknown) => e);
      assert.ok(error instanceof KanbioApiError);
      assert.equal(error.code, 'INVALID_TRANSITION');
      assert.deepEqual(error.params.allowed, ['Triage']);
      assert.match(describeError(error), /From Nuevo it can go to: Triage\./);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
