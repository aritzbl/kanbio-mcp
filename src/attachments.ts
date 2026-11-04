import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KanbioApiError } from './client.js';
import { ToolInputError } from './kanbio.js';

/**
 * Files in ticket descriptions and comments. Kanbio stores each one as a draft
 * of the project (reserve → PUT to S3 → complete) and attaches it when a text
 * that references it is saved: `![name](attachment:<uuid>)` marks its spot.
 */

export type AttachmentKind = 'image' | 'video' | 'document';

/** The types Kanbio accepts, by extension (mirror of the API's ATTACHMENT_TYPES). */
export const ATTACHMENT_TYPES: Readonly<
  Record<string, { contentType: string; kind: AttachmentKind }>
> = {
  '.png': { contentType: 'image/png', kind: 'image' },
  '.jpg': { contentType: 'image/jpeg', kind: 'image' },
  '.jpeg': { contentType: 'image/jpeg', kind: 'image' },
  '.mp4': { contentType: 'video/mp4', kind: 'video' },
  '.webm': { contentType: 'video/webm', kind: 'video' },
  '.mov': { contentType: 'video/quicktime', kind: 'video' },
  '.pdf': { contentType: 'application/pdf', kind: 'document' },
  '.csv': { contentType: 'text/csv', kind: 'document' },
  '.xlsx': {
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
  },
};

export const ACCEPTED_TYPES_TEXT =
  'images (PNG, JPEG), videos (MP4, WebM, MOV), PDF, CSV or XLSX';

/** What GET /attachments/limits answers (bytes). */
export interface AttachmentLimits {
  maxBytes: Record<AttachmentKind, number>;
  maxFilesPerBody: number;
  maxTotalBytesPerBody: number;
  maxDraftsPerUser: number;
}

/** The scope that publishes the text the files go into. */
export type PublishScope = 'comments:write' | 'tickets:create' | 'tickets:edit';

/** A local file checked against the accepted types. */
export interface LocalFile {
  path: string;
  name: string;
  contentType: string;
  kind: AttachmentKind;
  size: number;
}

/** A file uploaded as a ready draft. */
export interface UploadedFile {
  id: string;
  name: string;
}

/** The calls of the Kanbio API that uploading needs. */
export interface AttachmentApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
  putFile(url: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
}

const MAX_TOKEN_NAME_LENGTH = 80;
const MAX_FILE_NAME_LENGTH = 255;
const MB = 1024 * 1024;

const TOKEN = String.raw`!\[([^\]\n]{0,${MAX_TOKEN_NAME_LENGTH}})\]\(attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)`;
const tokenPattern = () => new RegExp(TOKEN, 'gi');

/** The token for a file, with a name Kanbio's pattern accepts (as the web app writes it). */
export function attachmentToken(id: string, name: string): string {
  const hint = name
    .replace(/[[\]()\r\n]/g, '')
    .trim()
    .slice(0, MAX_TOKEN_NAME_LENGTH);
  return `![${hint}](attachment:${id})`;
}

/** Files a text already references, once each. */
export function countAttachments(text: string | null | undefined): number {
  const ids = Array.from((text ?? '').matchAll(tokenPattern()), (m) =>
    m[2].toLowerCase(),
  );
  return new Set(ids).size;
}

/**
 * The text with the new files at the end, each on its own line (images and
 * videos show as blocks). The tokens do not count against the 5000 characters.
 */
export function withAttachments(
  text: string | null | undefined,
  files: UploadedFile[],
): string {
  const body = (text ?? '').trimEnd();
  if (files.length === 0) return body;
  const tokens = files.map((file) => attachmentToken(file.id, file.name)).join('\n');
  return body ? `${body}\n\n${tokens}` : tokens;
}

/**
 * A rewritten description with the files of the current one, which the AI
 * only sees as "[file: name]" (get_ticket). Each such placeholder of a current
 * file becomes its token again, and the files the new text leaves out go at
 * its end: rewriting a description never drops its evidence.
 */
export function keepFiles(
  text: string,
  current: string | null | undefined,
): string {
  let result = text;
  const missing: UploadedFile[] = [];
  for (const [token, name, id] of (current ?? '').matchAll(tokenPattern())) {
    if (result.toLowerCase().includes(`(attachment:${id.toLowerCase()})`)) {
      continue;
    }
    const placeholder = `[file: ${name || 'attachment'}]`;
    const at = result.indexOf(placeholder);
    if (at >= 0) {
      result = result.slice(0, at) + token + result.slice(at + placeholder.length);
    } else {
      missing.push({ id, name });
    }
  }
  return missing.length > 0 ? withAttachments(result, missing) : result;
}

/** A path as given: absolute, `~/…`, a `file://` URL or relative to the server's folder. */
function absolutePath(given: string): string {
  const path = given.trim();
  if (/^file:\/\//i.test(path)) return fileURLToPath(path);
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(1));
  }
  return isAbsolute(path) ? path : resolve(path);
}

/** Checks that each path is a non-empty file of an accepted type. Reads nothing yet. */
export async function localFiles(paths: string[]): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for (const given of paths) {
    const path = absolutePath(given);
    if (files.some((file) => file.path === path)) continue;
    const name = basename(path);
    const type = ATTACHMENT_TYPES[extname(name).toLowerCase()];
    if (!type) {
      throw new ToolInputError(
        `Kanbio does not accept "${name}": it takes ${ACCEPTED_TYPES_TEXT}.`,
      );
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      throw new ToolInputError(
        `File not found: ${path}. Give the absolute path of a file on the machine running the Kanbio MCP server.`,
      );
    }
    if (info.size === 0) throw new ToolInputError(`"${name}" is empty.`);
    files.push({ path, name, ...type, size: info.size });
  }
  return files;
}

const megabytes = (bytes: number) => `${Math.round((bytes / MB) * 10) / 10} MB`;

/** The limits Kanbio would reject, checked before uploading anything. */
export function checkLimits(
  files: LocalFile[],
  limits: AttachmentLimits,
  alreadyInText: number,
): void {
  for (const file of files) {
    const max = limits.maxBytes[file.kind];
    if (file.size > max) {
      throw new ToolInputError(
        `"${file.name}" weighs ${megabytes(file.size)}; Kanbio takes ${file.kind} files of up to ${megabytes(max)}.`,
      );
    }
  }
  const count = alreadyInText + files.length;
  if (count > limits.maxFilesPerBody) {
    throw new ToolInputError(
      `A description or comment can have up to ${limits.maxFilesPerBody} files${alreadyInText ? ` (it already has ${alreadyInText})` : ''}.`,
    );
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.maxTotalBytesPerBody) {
    throw new ToolInputError(
      `The files add up to ${megabytes(total)}; a description or comment can carry up to ${megabytes(limits.maxTotalBytesPerBody)}.`,
    );
  }
}

/**
 * Without any scope that publishes files the API names the three; the tool
 * knows which one its text needs, so the AI can tell the user exactly that.
 */
function forScope(error: unknown, scope: PublishScope): unknown {
  if (
    error instanceof KanbioApiError &&
    error.status === 403 &&
    /lacks one of the permissions/.test(error.apiMessage)
  ) {
    return new KanbioApiError(403, `This API token lacks the permission: ${scope}`);
  }
  return error;
}

/** Best effort: Kanbio purges forgotten drafts every hour anyway. */
async function discard(api: AttachmentApi, files: UploadedFile[]): Promise<void> {
  await Promise.all(
    files.map((file) =>
      api.delete(`/attachments/${file.id}`).catch(() => undefined),
    ),
  );
}

export interface AttachmentSave {
  projectId: string;
  /** Local paths given by the AI. */
  paths: string[];
  /** The text the files go at the end of. */
  text: string | null | undefined;
  scope: PublishScope;
}

/**
 * Uploads the files as drafts of the project and saves the text that
 * references them (Kanbio attaches them then). Local checks and the limits
 * come first, so a bad path or a too large file uploads nothing. If an upload
 * or the save fails, the drafts uploaded here are discarded and the error goes
 * on: a permission error of the save reaches the AI as is.
 */
export async function saveWithAttachments<T>(
  api: AttachmentApi,
  { projectId, paths, text, scope }: AttachmentSave,
  save: (text: string) => Promise<T>,
): Promise<{ result: T; files: UploadedFile[] }> {
  const files = await localFiles(paths);
  const limits = await api
    .get<AttachmentLimits>('/attachments/limits')
    .catch((error: unknown) => Promise.reject(forScope(error, scope)));
  checkLimits(files, limits, countAttachments(text));

  const uploaded: UploadedFile[] = [];
  try {
    for (const file of files) {
      const bytes = await readFile(file.path);
      // The id is ours: the text can reference the file before it is ready.
      const draft = { id: randomUUID(), name: file.name.slice(0, MAX_FILE_NAME_LENGTH) };
      const { uploadUrl } = await api.post<{ uploadUrl: string }>(
        `/projects/${projectId}/attachments`,
        { ...draft, contentType: file.contentType, size: bytes.length },
      );
      uploaded.push(draft);
      await api.putFile(uploadUrl, bytes, file.contentType);
      await api.post(`/attachments/${draft.id}/complete`, {});
    }
  } catch (error) {
    await discard(api, uploaded);
    throw forScope(error, scope);
  }

  try {
    return { result: await save(withAttachments(text, uploaded)), files: uploaded };
  } catch (error) {
    await discard(api, uploaded);
    throw error;
  }
}

/** "2 files (a.png, b.pdf)" for the tool answers. */
export function filesText(files: UploadedFile[]): string {
  return `${files.length} file${files.length === 1 ? '' : 's'} (${files.map((file) => file.name).join(', ')})`;
}
