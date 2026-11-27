import {
  allowedTargets,
  CommentNode,
  Member,
  Project,
  Sprint,
  stateList,
  Ticket,
  personName,
  Workflow,
} from './kanbio.js';

const MENTION = /@\[([^\]\n]{1,80})\]\(user:([0-9a-f-]{36})\)/gi;
const ATTACHMENT = /!\[([^\]\n]*)\]\(attachment:[0-9a-f-]{36}\)/gi;

/** Text as people read it: `@Name` for mentions, `[file: name]` for attachments. */
export function readableText(text: string): string {
  return text
    .replace(MENTION, (_token, name: string) => `@${name}`)
    .replace(ATTACHMENT, (_token, name: string) => `[file: ${name || 'attachment'}]`);
}

/**
 * Writes mentions the way Kanbio stores them: `@[Name](user:<id>)`. Each
 * `@Name` already in the text becomes the mention; people not named in the
 * text are mentioned at the start.
 */
export function withMentions(text: string, people: Member[]): string {
  let result = text;
  const prefix: string[] = [];
  for (const person of people) {
    const name = personName(person).replace(/[\]\n]/g, ' ').slice(0, 80);
    const token = `@[${name}](user:${person.id})`;
    const plain = new RegExp(`@${escapeRegExp(name)}(?![\\w])`, 'i');
    if (plain.test(result)) {
      result = result.replace(plain, token);
    } else {
      prefix.push(token);
    }
  }
  return prefix.length > 0 ? `${prefix.join(' ')} ${result}` : result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Names {
  people: Map<string, string>;
  sprints: Map<string, string>;
  projects: Map<string, string>;
}

export function emptyNames(): Names {
  return { people: new Map(), sprints: new Map(), projects: new Map() };
}

export function addPeople(names: Names, members: Member[]): void {
  for (const member of members) names.people.set(member.id, personName(member));
}

export function addSprints(names: Names, sprints: Sprint[]): void {
  for (const sprint of sprints) names.sprints.set(sprint.id, sprint.name);
}

export function addProjects(names: Names, projects: Project[]): void {
  for (const project of projects) names.projects.set(project.id, project.key);
}

function person(names: Names, id: string | null): string {
  if (!id) return 'unassigned';
  return names.people.get(id) ?? 'a former member';
}

function sprintName(names: Names, id: string | null): string {
  if (!id) return 'backlog';
  return names.sprints.get(id) ?? 'a sprint';
}

/**
 * One line per ticket: key, status, type, priority, title, assignee, sprint.
 * A subtask ends with `↳ PARENT-KEY`, a parent with `subtasks done/total`.
 */
export function ticketLine(ticket: Ticket, names: Names): string {
  const points = ticket.storyPoints ? ` · ${ticket.storyPoints} pts` : '';
  const progress = ticket.subtaskProgress;
  const marks = [
    ticket.parent ? `↳ ${ticket.parent.key}` : '',
    progress && progress.total > 0 ? `subtasks ${progress.done}/${progress.total}` : '',
  ].filter(Boolean);
  const tail = marks.map((mark) => ` · ${mark}`).join('');
  return `${ticket.key} · ${ticket.status} · ${ticket.type} · ${ticket.priority}${points} · "${ticket.title}" · ${person(names, ticket.assigneeId)} · ${sprintName(names, ticket.sprintId)}${tail}`;
}

const SUBTASKS_SHOWN = 30;
const SUBTASK_TITLE_LIMIT = 120;

/** The parent line and the subtasks block of get_ticket (empty when neither applies). */
function subtaskLines(ticket: Ticket, names: Names): string[] {
  const lines: string[] = [];
  const parent = ticket.parent;
  if (parent) {
    lines.push(
      `Parent: ${parent.key} · ${parent.status} · "${truncate(parent.title, SUBTASK_TITLE_LIMIT)}" · ${sprintName(names, parent.sprintId)}`,
    );
  }
  const subtasks = ticket.subtasks ?? [];
  if (subtasks.length > 0) {
    const done =
      ticket.subtaskProgress?.done ?? subtasks.filter((s) => s.isDone).length;
    const total = ticket.subtaskProgress?.total ?? subtasks.length;
    lines.push(`Subtasks (${done}/${total} done):`);
    for (const sub of subtasks.slice(0, SUBTASKS_SHOWN)) {
      const outside =
        !sub.isDone && sub.sprintId !== ticket.sprintId
          ? " ⚠ open, outside the parent's sprint"
          : '';
      lines.push(
        `- ${sub.key} · ${sub.status} · "${truncate(sub.title, SUBTASK_TITLE_LIMIT)}" · ${person(names, sub.assigneeId)} · ${sprintName(names, sub.sprintId)}${outside}`,
      );
    }
    if (subtasks.length > SUBTASKS_SHOWN) {
      lines.push(`… and ${subtasks.length - SUBTASKS_SHOWN} more`);
    }
  }
  return lines;
}

const DESCRIPTION_LIMIT = 4000;

/**
 * The whole ticket. With the workflow of its project it also says whether the
 * status counts as finished and where the ticket can move.
 */
export function ticketDetail(
  ticket: Ticket,
  names: Names,
  comments: CommentNode[] | null,
  workflow: Workflow | null = null,
): string {
  const state = workflow?.states.find((s) => s.id === ticket.stateId);
  const lines = [
    `${ticket.key}: ${ticket.title}`,
    `Status: ${ticket.status}${state?.isDone ? ' (finished)' : ''}`,
    ...(workflow
      ? [`Can move to: ${stateList(allowedTargets(workflow, ticket.stateId))}`]
      : []),
    `Type: ${ticket.type} · Priority: ${ticket.priority}${ticket.storyPoints ? ` · ${ticket.storyPoints} story points` : ''}`,
    `Assignee: ${person(names, ticket.assigneeId)} · Reporter: ${person(names, ticket.reporterId)}`,
    `Sprint: ${sprintName(names, ticket.sprintId)}${ticket.labels.length ? ` · Labels: ${ticket.labels.join(', ')}` : ''}`,
    `Updated: ${ticket.updatedAt.slice(0, 16).replace('T', ' ')} UTC`,
    ...subtaskLines(ticket, names),
    '',
    'Description:',
    ticket.description
      ? truncate(readableText(ticket.description), DESCRIPTION_LIMIT)
      : '(none)',
  ];
  if (comments) {
    lines.push('', `Comments (${countComments(comments)}):`);
    if (comments.length === 0) lines.push('(none)');
    for (const comment of comments) {
      lines.push(commentLine(comment, names, ''));
      for (const reply of comment.replies) {
        lines.push(commentLine(reply, names, '  ↳ '));
      }
    }
  }
  return lines.join('\n');
}

function countComments(comments: CommentNode[]): number {
  return comments.reduce(
    (total, comment) => total + (comment.deleted ? 0 : 1) + comment.replies.length,
    0,
  );
}

function commentLine(comment: CommentNode, names: Names, indent: string): string {
  const when = comment.createdAt.slice(0, 16).replace('T', ' ');
  if (comment.deleted) return `${indent}- [${when}] (deleted comment)`;
  const via = comment.viaApiToken ? ' (via AI)' : '';
  return `${indent}- [${when}] ${person(names, comment.authorId)}${via}: ${truncate(readableText(comment.content), 1500)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}
