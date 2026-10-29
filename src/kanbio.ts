import { KanbioApiError, KanbioClient } from './client.js';

export const STATUSES = [
  'todo',
  'in_progress',
  'to_merge',
  'qa',
  'done',
  'rejected',
] as const;
export type Status = (typeof STATUSES)[number];

/** How Kanbio shows each status. */
export const STATUS_LABELS: Record<Status, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  to_merge: 'To Merge',
  qa: 'To Test',
  done: 'Done',
  rejected: 'Rejected',
};

/** Mirror of the API workflow, only used to explain a rejected move. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  todo: ['in_progress'],
  in_progress: ['to_merge', 'qa'],
  to_merge: ['qa'],
  qa: ['done', 'rejected'],
  done: ['qa', 'in_progress'],
  rejected: ['qa', 'in_progress'],
};

export const WORKFLOW_TEXT =
  'To Do → In Progress → [To Merge →] To Test → Done | Rejected; Done and Rejected can go back to To Test or In Progress. To Merge is optional and only reachable from In Progress.';

export const TICKET_TYPES = ['bug', 'task', 'story'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  myRole: string | null;
}

export interface Member {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  role: string;
}

export interface Sprint {
  id: string;
  name: string;
  goal: string | null;
  status: 'planned' | 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
}

export interface Ticket {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  storyPoints: number | null;
  status: Status;
  reporterId: string;
  assigneeId: string | null;
  sprintId: string | null;
  epicId: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CommentNode {
  id: string;
  authorId: string;
  content: string;
  deleted: boolean;
  viaApiToken?: boolean;
  createdAt: string;
  updatedAt: string;
  replies: CommentNode[];
}

/** A user-facing problem (wrong key, ambiguous name...), shown as is to the AI. */
export class ToolInputError extends Error {}

const CACHE_MS = 60_000;

interface Cached<T> {
  value: Promise<T>;
  at: number;
}

/** Shows a person the way Kanbio does. */
export function personName(member: Pick<Member, 'displayName' | 'firstName' | 'lastName' | 'email'>): string {
  return (
    member.displayName?.trim() ||
    `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim() ||
    member.email
  );
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Kanbio as the tools see it: projects by key, tickets by key, people and
 * sprints by name. Lists that rarely change are cached for a minute.
 */
export class Kanbio {
  private projectsCache: Cached<Project[]> | null = null;
  private meCache: Cached<Member> | null = null;
  private readonly members = new Map<string, Cached<Member[]>>();
  private readonly sprints = new Map<string, Cached<Sprint[]>>();

  constructor(readonly api: KanbioClient) {}

  private cached<T>(
    entry: Cached<T> | null | undefined,
    load: () => Promise<T>,
    store: (entry: Cached<T>) => void,
  ): Promise<T> {
    if (entry && Date.now() - entry.at < CACHE_MS) return entry.value;
    const value = load();
    // A failed load is not cached.
    value.catch(() => store({ value, at: 0 }));
    store({ value, at: Date.now() });
    return value;
  }

  projects(): Promise<Project[]> {
    return this.cached(
      this.projectsCache,
      () => this.api.get<Project[]>('/projects'),
      (entry) => (this.projectsCache = entry),
    );
  }

  me(): Promise<Member> {
    return this.cached(
      this.meCache,
      () => this.api.get<Member>('/users/me'),
      (entry) => (this.meCache = entry),
    );
  }

  async project(key: string): Promise<Project> {
    const wanted = key.trim().toUpperCase();
    const projects = await this.projects();
    const project = projects.find((p) => p.key.toUpperCase() === wanted);
    if (!project) {
      const known = projects.map((p) => p.key).join(', ') || 'none';
      throw new ToolInputError(
        `There is no project "${key}" reachable with this token. Projects available: ${known}.`,
      );
    }
    return project;
  }

  async projectById(id: string): Promise<Project | undefined> {
    return (await this.projects()).find((project) => project.id === id);
  }

  projectMembers(projectId: string): Promise<Member[]> {
    return this.cached(
      this.members.get(projectId),
      async () => {
        const all: Member[] = [];
        for (let page = 1; page <= 10; page++) {
          const result = await this.api.get<{
            items: Member[];
            totalPages: number;
          }>(`/projects/${projectId}/members`, { page, pageSize: 100 });
          all.push(...result.items);
          if (page >= result.totalPages) break;
        }
        return all;
      },
      (entry) => this.members.set(projectId, entry),
    );
  }

  projectSprints(projectId: string): Promise<Sprint[]> {
    return this.cached(
      this.sprints.get(projectId),
      () => this.api.get<Sprint[]>(`/projects/${projectId}/sprints`),
      (entry) => this.sprints.set(projectId, entry),
    );
  }

  /** Forgets the sprints of a project (after moving tickets around). */
  forgetSprints(projectId: string): void {
    this.sprints.delete(projectId);
  }

  async ticket(key: string): Promise<Ticket> {
    const clean = key.trim();
    if (!/^[A-Za-z0-9_-]+-\d+$/.test(clean)) {
      throw new ToolInputError(
        `"${key}" is not a ticket key. Keys look like PROJ-12.`,
      );
    }
    try {
      return await this.api.get<Ticket>(
        `/tickets/by-key/${encodeURIComponent(clean)}`,
      );
    } catch (error) {
      if (error instanceof KanbioApiError && error.status === 404) {
        throw new ToolInputError(`Ticket ${clean.toUpperCase()} does not exist.`);
      }
      throw error;
    }
  }

  /**
   * A member of the project by "me", email or name (accents and case do not
   * matter). Ambiguous or unknown names are explained.
   */
  async member(projectId: string, query: string): Promise<Member> {
    if (normalize(query) === 'me') return this.me();
    const members = await this.projectMembers(projectId);
    const found = matchPeople(members, query);
    if (found.length === 1) return found[0];
    const project = await this.projectById(projectId);
    if (found.length === 0) {
      const names = members.map((m) => `${personName(m)} <${m.email}>`).join(', ');
      throw new ToolInputError(
        `Nobody in ${project?.key ?? 'the project'} matches "${query}". Members: ${names || 'none'}.`,
      );
    }
    throw new ToolInputError(
      `"${query}" matches several people in ${project?.key ?? 'the project'}: ${found
        .map((m) => `${personName(m)} <${m.email}>`)
        .join(', ')}. Use the email.`,
    );
  }

  /** A sprint of the project by "active", name or id. */
  async sprint(projectId: string, query: string): Promise<Sprint> {
    const sprints = await this.projectSprints(projectId);
    const wanted = normalize(query);
    const open = sprints.filter((s) => s.status !== 'completed');
    const found =
      wanted === 'active'
        ? sprints.filter((s) => s.status === 'active')
        : sprints.filter(
            (s) => s.id === query.trim() || normalize(s.name) === wanted,
          );
    if (found.length === 1) return found[0];
    const project = await this.projectById(projectId);
    const listed =
      open.map((s) => `${s.name} (${s.status})`).join(', ') || 'none';
    throw new ToolInputError(
      wanted === 'active'
        ? `${project?.key ?? 'The project'} has no active sprint. Open sprints: ${listed}.`
        : `No sprint "${query}" in ${project?.key ?? 'the project'}. Open sprints: ${listed}.`,
    );
  }
}

/** People whose email is the query, or whose name contains it. */
export function matchPeople<T extends Member>(people: T[], query: string): T[] {
  const wanted = normalize(query.replace(/^@/, ''));
  if (!wanted) return [];
  const byEmail = people.filter((p) => normalize(p.email) === wanted);
  if (byEmail.length > 0) return byEmail;
  const exact = people.filter((p) => normalize(personName(p)) === wanted);
  if (exact.length > 0) return exact;
  return people.filter((p) =>
    [personName(p), `${p.firstName} ${p.lastName}`, p.email].some((text) =>
      normalize(text).includes(wanted),
    ),
  );
}
