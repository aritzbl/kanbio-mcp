import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describeError } from './errors.js';
import {
  addPeople,
  addProjects,
  addSprints,
  emptyNames,
  Names,
  readableText,
  ticketDetail,
  ticketLine,
  withMentions,
} from './format.js';
import {
  CommentNode,
  Kanbio,
  Member,
  matchPeople,
  personName,
  PRIORITIES,
  STATUS_LABELS,
  STATUSES,
  STORY_POINTS,
  Ticket,
  TICKET_TYPES,
  ToolInputError,
  WORKFLOW_TEXT,
} from './kanbio.js';

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const keySchema = z
  .string()
  .min(3)
  .max(80)
  .describe('Ticket key, e.g. PROJ-12 (case does not matter).');
const projectSchema = z
  .string()
  .min(1)
  .max(50)
  .describe('Project key, e.g. PROJ (see list_projects).');
const statusSchema = z
  .enum(STATUSES)
  .describe(
    'Status id: todo (To Do), in_progress (In Progress), to_merge (To Merge), qa (To Test), done (Done), rejected (Rejected).',
  );
const personSchema = z
  .string()
  .min(1)
  .max(120)
  .describe('"me", an email, or a name of a project member.');
const sprintSchema = z
  .string()
  .min(1)
  .max(80)
  .describe('"active" (the active sprint), "backlog", or a sprint name.');

type Result = CallToolResult;

function text(value: string): Result {
  return { content: [{ type: 'text', text: value }] };
}

/** Runs a tool and turns any failure into a message the AI can act on. */
async function run(action: () => Promise<string>): Promise<Result> {
  try {
    return text(await action());
  } catch (error) {
    return { content: [{ type: 'text', text: describeError(error) }], isError: true };
  }
}

/** Names for the people, sprints and projects of these tickets. */
async function namesFor(kanbio: Kanbio, tickets: Ticket[]): Promise<Names> {
  const names = emptyNames();
  addProjects(names, await kanbio.projects());
  const projectIds = [...new Set(tickets.map((ticket) => ticket.projectId))];
  await Promise.all(
    projectIds.map(async (projectId) => {
      const [members, sprints] = await Promise.all([
        kanbio.projectMembers(projectId),
        kanbio.projectSprints(projectId),
      ]);
      addPeople(names, members);
      addSprints(names, sprints);
    }),
  );
  return names;
}

/** An assignee filter for the search: "me", "none" or a user id. */
async function assigneeFilter(
  kanbio: Kanbio,
  query: string,
  projectId: string | undefined,
): Promise<string> {
  const wanted = query.trim().toLowerCase();
  if (wanted === 'me') return 'me';
  if (['none', 'unassigned', 'nobody'].includes(wanted)) return 'none';
  if (projectId) return (await kanbio.member(projectId, query)).id;
  // Without a project, look for the person in every reachable project.
  const projects = await kanbio.projects();
  const everyone = new Map<string, Member>();
  for (const members of await Promise.all(
    projects.slice(0, 30).map((project) => kanbio.projectMembers(project.id)),
  )) {
    for (const member of members) everyone.set(member.id, member);
  }
  const found = matchPeople([...everyone.values()], query);
  if (found.length === 1) return found[0].id;
  if (found.length === 0) {
    throw new ToolInputError(`Nobody in your projects matches "${query}".`);
  }
  throw new ToolInputError(
    `"${query}" matches several people: ${found
      .map((m) => `${personName(m)} <${m.email}>`)
      .join(', ')}. Use the email.`,
  );
}

interface SearchResult {
  items: Ticket[];
  total: number;
}

async function listTickets(
  kanbio: Kanbio,
  result: SearchResult,
  empty: string,
): Promise<string> {
  if (result.items.length === 0) return empty;
  const names = await namesFor(kanbio, result.items);
  const lines = result.items.map((ticket) => ticketLine(ticket, names));
  const more =
    result.total > result.items.length
      ? `Showing ${result.items.length} of ${result.total} (raise limit or narrow the filters to see more).`
      : `${result.total} ticket${result.total === 1 ? '' : 's'}.`;
  return [
    'key · status · type · priority · title · assignee · sprint',
    ...lines,
    more,
  ].join('\n');
}

export function registerTools(server: McpServer, kanbio: Kanbio): void {
  // ---- Read ----

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the Kanbio projects this token can reach, with their key (used by the other tools) and your role in each.',
      annotations: READ,
    },
    () =>
      run(async () => {
        const projects = await kanbio.projects();
        if (projects.length === 0) return 'This token reaches no projects.';
        return projects
          .map(
            (p) =>
              `${p.key} — ${p.name}${p.myRole ? ` (your role: ${p.myRole})` : ''}`,
          )
          .join('\n');
      }),
  );

  server.registerTool(
    'search_tickets',
    {
      title: 'Search tickets',
      description:
        'Search tickets across your projects, most recently updated first. Every filter is optional and they combine (AND). Returns one compact line per ticket; use get_ticket for the full ticket.',
      inputSchema: {
        project: projectSchema.optional(),
        status: z
          .array(statusSchema)
          .min(1)
          .max(STATUSES.length)
          .optional()
          .describe('Any of these statuses.'),
        assignee: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe('"me", "none" (unassigned), an email or a name.'),
        sprint: sprintSchema
          .optional()
          .describe(
            '"active" (each project\'s active sprint), "backlog", or a sprint name (needs project).',
          ),
        text: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Words in the key, title or description.'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ,
    },
    (input) =>
      run(async () => {
        const project = input.project
          ? await kanbio.project(input.project)
          : undefined;
        let sprint: string | undefined;
        if (input.sprint) {
          const wanted = input.sprint.trim().toLowerCase();
          if (wanted === 'active' || wanted === 'backlog') sprint = wanted;
          else if (!project) {
            throw new ToolInputError(
              'To filter by a sprint name, also give the project.',
            );
          } else sprint = (await kanbio.sprint(project.id, input.sprint)).id;
        }
        const result = await kanbio.api.get<SearchResult>('/tickets/search', {
          projectId: project?.id,
          status: input.status,
          assigneeId: input.assignee
            ? await assigneeFilter(kanbio, input.assignee, project?.id)
            : undefined,
          sprint,
          q: input.text,
          limit: input.limit,
        });
        return listTickets(kanbio, result, 'No tickets match.');
      }),
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get a ticket',
      description:
        'Read one ticket by key: status, type, priority, assignee, sprint, description and its comments (threads, oldest first; "via AI" marks comments written through a token).',
      inputSchema: {
        key: keySchema,
        include_comments: z.boolean().default(true),
      },
      annotations: READ,
    },
    (input) =>
      run(async () => {
        const ticket = await kanbio.ticket(input.key);
        const [names, comments] = await Promise.all([
          namesFor(kanbio, [ticket]),
          input.include_comments
            ? kanbio.api.get<CommentNode[]>(`/tickets/${ticket.id}/comments`)
            : Promise.resolve(null),
        ]);
        return ticketDetail(ticket, names, comments);
      }),
  );

  server.registerTool(
    'list_sprints',
    {
      title: 'List sprints',
      description:
        'List the sprints of a project (planned and active; completed ones on request), with dates and goal.',
      inputSchema: {
        project: projectSchema,
        include_completed: z.boolean().default(false),
      },
      annotations: READ,
    },
    (input) =>
      run(async () => {
        const project = await kanbio.project(input.project);
        const sprints = (await kanbio.projectSprints(project.id)).filter(
          (s) => input.include_completed || s.status !== 'completed',
        );
        if (sprints.length === 0) return `${project.key} has no open sprints.`;
        return sprints
          .map((s) => {
            const dates =
              s.startDate && s.endDate
                ? ` · ${s.startDate.slice(0, 10)} → ${s.endDate.slice(0, 10)}`
                : '';
            return `${s.name} · ${s.status}${dates}${s.goal ? ` · goal: ${s.goal}` : ''}`;
          })
          .join('\n');
      }),
  );

  server.registerTool(
    'list_members',
    {
      title: 'List project members',
      description:
        'List the members of a project with their email and role (pm, dev, qa), e.g. to assign or mention someone.',
      inputSchema: { project: projectSchema },
      annotations: READ,
    },
    (input) =>
      run(async () => {
        const project = await kanbio.project(input.project);
        const members = await kanbio.projectMembers(project.id);
        if (members.length === 0) return `${project.key} has no members.`;
        return members
          .map((m) => `${personName(m)} <${m.email}> · ${m.role}`)
          .join('\n');
      }),
  );

  server.registerTool(
    'my_tickets',
    {
      title: 'My tickets',
      description:
        'Tickets assigned to the token owner across their projects, most recently updated first. Open ones only unless include_done.',
      inputSchema: {
        include_done: z
          .boolean()
          .default(false)
          .describe('Also list Done and Rejected tickets.'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ,
    },
    (input) =>
      run(async () => {
        const result = await kanbio.api.get<SearchResult>('/tickets/search', {
          assigneeId: 'me',
          status: input.include_done
            ? undefined
            : STATUSES.filter((s) => s !== 'done' && s !== 'rejected'),
          limit: input.limit,
        });
        return listTickets(
          kanbio,
          result,
          input.include_done
            ? 'You have no tickets assigned.'
            : 'You have no open tickets assigned.',
        );
      }),
  );

  // ---- Write (nothing here deletes) ----

  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment',
      description:
        'Add a comment to a ticket as the token owner; Kanbio shows it with a "via AI" badge. To mention people, list them in `mentions` (email or name): each "@Name" already in the text becomes the mention, the rest are mentioned at the start. Mentioned people get a notification. Needs the comments:write permission.',
      inputSchema: {
        key: keySchema,
        text: z.string().min(1).max(2000).describe('Comment text (plain text).'),
        mentions: z
          .array(personSchema)
          .max(20)
          .optional()
          .describe('People to mention: emails or names of project members.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    (input) =>
      run(async () => {
        const ticket = await kanbio.ticket(input.key);
        const people = await Promise.all(
          (input.mentions ?? []).map((m) => kanbio.member(ticket.projectId, m)),
        );
        const unique = [...new Map(people.map((p) => [p.id, p])).values()];
        const comment = await kanbio.api.post<CommentNode>(
          `/tickets/${ticket.id}/comments`,
          { content: withMentions(input.text, unique) },
        );
        return `Comment added to ${ticket.key}: "${readableText(comment.content)}"`;
      }),
  );

  server.registerTool(
    'change_status',
    {
      title: 'Change the status',
      description: `Move a ticket to another status. Kanbio enforces the workflow: ${WORKFLOW_TEXT} An invalid move is rejected with the allowed next statuses. Needs the tickets:status permission.`,
      inputSchema: { key: keySchema, status: statusSchema },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) =>
      run(async () => {
        const ticket = await kanbio.ticket(input.key);
        if (ticket.status === input.status) {
          return `${ticket.key} is already in ${STATUS_LABELS[ticket.status]}.`;
        }
        const updated = await kanbio.api.patch<Ticket>(`/tickets/${ticket.id}`, {
          status: input.status,
        });
        return `${updated.key}: ${STATUS_LABELS[ticket.status]} → ${STATUS_LABELS[updated.status]}.`;
      }),
  );

  server.registerTool(
    'assign_ticket',
    {
      title: 'Assign a ticket',
      description:
        'Assign a ticket to a project member ("me", email or name), or unassign it with "none". The person must be a member of the ticket\'s project. Needs the tickets:assign permission.',
      inputSchema: {
        key: keySchema,
        assignee: z
          .string()
          .min(1)
          .max(120)
          .describe('"me", "none" to unassign, an email or a name.'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) =>
      run(async () => {
        const ticket = await kanbio.ticket(input.key);
        const wanted = input.assignee.trim().toLowerCase();
        const person = ['none', 'unassigned', 'nobody'].includes(wanted)
          ? null
          : await kanbio.member(ticket.projectId, input.assignee);
        await kanbio.api.patch<Ticket>(`/tickets/${ticket.id}`, {
          assigneeId: person?.id ?? null,
        });
        return person
          ? `${ticket.key} assigned to ${personName(person)}.`
          : `${ticket.key} is now unassigned.`;
      }),
  );

  server.registerTool(
    'create_ticket',
    {
      title: 'Create a ticket',
      description:
        'Create a ticket in a project, reported by the token owner. It starts in To Do. Optionally assign it (needs tickets:assign) or plan it into a sprint (needs sprints:write); otherwise it goes to the backlog. Needs the tickets:create permission.',
      inputSchema: {
        project: projectSchema,
        title: z.string().min(1).max(200),
        type: z
          .enum(TICKET_TYPES)
          .describe('bug, task or story (user story).'),
        description: z.string().max(8000).optional(),
        priority: z.enum(PRIORITIES).default('medium'),
        story_points: z
          .number()
          .int()
          .refine((n) => (STORY_POINTS as readonly number[]).includes(n), {
            message: `Story points must be one of ${STORY_POINTS.join(', ')}`,
          })
          .optional()
          .describe(`Fibonacci: ${STORY_POINTS.join(', ')}.`),
        assignee: personSchema.optional(),
        sprint: sprintSchema.optional(),
        labels: z.array(z.string().min(1).max(40)).max(20).optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    (input) =>
      run(async () => {
        const project = await kanbio.project(input.project);
        const assignee = input.assignee
          ? await kanbio.member(project.id, input.assignee)
          : null;
        const wantedSprint = input.sprint?.trim().toLowerCase();
        const sprint =
          input.sprint && wantedSprint !== 'backlog'
            ? await kanbio.sprint(project.id, input.sprint)
            : null;
        const ticket = await kanbio.api.post<Ticket>(
          `/projects/${project.id}/tickets`,
          {
            title: input.title,
            type: input.type,
            description: input.description,
            priority: input.priority,
            storyPoints: input.story_points,
            labels: input.labels,
            ...(assignee ? { assigneeId: assignee.id } : {}),
            ...(sprint ? { sprintId: sprint.id } : {}),
          },
        );
        return `Created ${ticket.key}: "${ticket.title}" (To Do, ${sprint ? sprint.name : 'backlog'}${assignee ? `, assigned to ${personName(assignee)}` : ''}).`;
      }),
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Update a ticket',
      description:
        'Edit the fields of a ticket: title, description, type, priority, story points or labels. Only the fields given change. Status, assignee and sprint have their own tools. Needs the tickets:edit permission.',
      inputSchema: {
        key: keySchema,
        title: z.string().min(1).max(200).optional(),
        description: z
          .string()
          .max(8000)
          .nullable()
          .optional()
          .describe('New description; null clears it.'),
        type: z.enum(TICKET_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        story_points: z
          .number()
          .int()
          .refine((n) => (STORY_POINTS as readonly number[]).includes(n), {
            message: `Story points must be one of ${STORY_POINTS.join(', ')}`,
          })
          .nullable()
          .optional()
          .describe(`Fibonacci: ${STORY_POINTS.join(', ')}; null clears them.`),
        labels: z
          .array(z.string().min(1).max(40))
          .max(20)
          .optional()
          .describe('Replaces every label.'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) =>
      run(async () => {
        const patch: Record<string, unknown> = {};
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.type !== undefined) patch.type = input.type;
        if (input.priority !== undefined) patch.priority = input.priority;
        if (input.story_points !== undefined) patch.storyPoints = input.story_points;
        if (input.labels !== undefined) patch.labels = input.labels;
        const fields = Object.keys(patch);
        if (fields.length === 0) {
          throw new ToolInputError(
            'Nothing to change: give at least one of title, description, type, priority, story_points or labels.',
          );
        }
        const ticket = await kanbio.ticket(input.key);
        await kanbio.api.patch<Ticket>(`/tickets/${ticket.id}`, patch);
        return `${ticket.key} updated (${fields.join(', ')}).`;
      }),
  );

  server.registerTool(
    'move_to_sprint',
    {
      title: 'Move tickets to a sprint',
      description:
        'Move one or more tickets to a sprint ("active" or a sprint name) or back to the backlog ("backlog"). Completed sprints are not allowed. Needs the sprints:write permission.',
      inputSchema: {
        keys: z.array(keySchema).min(1).max(50),
        sprint: sprintSchema,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) =>
      run(async () => {
        const tickets = await Promise.all(input.keys.map((key) => kanbio.ticket(key)));
        const toBacklog = input.sprint.trim().toLowerCase() === 'backlog';
        const byProject = new Map<string, Ticket[]>();
        for (const ticket of tickets) {
          byProject.set(ticket.projectId, [
            ...(byProject.get(ticket.projectId) ?? []),
            ticket,
          ]);
        }
        const lines: string[] = [];
        for (const [projectId, group] of byProject) {
          const sprint = toBacklog ? null : await kanbio.sprint(projectId, input.sprint);
          await kanbio.api.post<Ticket[]>(`/projects/${projectId}/tickets/move`, {
            ticketIds: [...new Set(group.map((ticket) => ticket.id))],
            sprintId: sprint?.id ?? null,
          });
          kanbio.forgetSprints(projectId);
          lines.push(
            `${group.map((ticket) => ticket.key).join(', ')} → ${sprint ? sprint.name : 'backlog'}.`,
          );
        }
        return lines.join('\n');
      }),
  );
}
