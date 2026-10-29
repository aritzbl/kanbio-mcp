/** Minimal client for the Kanbio REST API, authenticated with a personal access token. */

export interface KanbioConfig {
  /** Base URL of the API, ending in /api. */
  apiUrl: string;
  token: string;
}

/** An error answered by the API (or the network), with the raw details kept. */
export class KanbioApiError extends Error {
  constructor(
    readonly status: number,
    /** The API message (first one when there are several). */
    readonly apiMessage: string,
    /** Validation details, when the API sends them. */
    readonly details: string[] = [],
  ) {
    super(`Kanbio API ${status}: ${apiMessage}`);
  }
}

/** Status 0: Kanbio could not be reached at all. */
export const NETWORK_ERROR = 0;

const TIMEOUT_MS = 20_000;

/**
 * Reads KANBIO_API_URL and KANBIO_TOKEN. The URL may be given with or without
 * the /api suffix. Returns a list of problems instead of throwing, so the
 * server still starts and the tools can explain what to fix.
 */
export function readConfig(
  env: NodeJS.ProcessEnv,
): { config: KanbioConfig; problems: [] } | { config: null; problems: string[] } {
  const problems: string[] = [];
  const rawUrl = env.KANBIO_API_URL?.trim();
  const token = env.KANBIO_TOKEN?.trim();
  let apiUrl = '';
  if (!rawUrl) {
    problems.push(
      'KANBIO_API_URL is not set (the URL of the Kanbio API, e.g. https://kanbio.example.com/api).',
    );
  } else {
    try {
      const url = new URL(rawUrl);
      const path = url.pathname.replace(/\/+$/, '');
      url.pathname = path.endsWith('/api') ? path : `${path}/api`;
      apiUrl = url.toString().replace(/\/+$/, '');
    } catch {
      problems.push(`KANBIO_API_URL is not a valid URL: ${rawUrl}`);
    }
  }
  if (!token) {
    problems.push(
      'KANBIO_TOKEN is not set. Create a token in Kanbio (sidebar → "Conectar con IA") and set it in the MCP config.',
    );
  } else if (!token.startsWith('kbn_')) {
    problems.push(
      'KANBIO_TOKEN does not look like a Kanbio token (they start with "kbn_").',
    );
  }
  if (problems.length > 0 || !token) return { config: null, problems };
  return { config: { apiUrl, token }, problems: [] };
}

type Query = Record<string, string | number | string[] | undefined>;

export class KanbioClient {
  constructor(
    private readonly config: KanbioConfig,
    private readonly userAgent: string,
  ) {}

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<T> {
    const url = new URL(`${this.config.apiUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(
        name,
        Array.isArray(value) ? value.join(',') : String(value),
      );
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new KanbioApiError(
        NETWORK_ERROR,
        `Could not reach Kanbio at ${this.config.apiUrl} (${reason})`,
      );
    }
    const text = await response.text();
    const payload: unknown = text ? safeJson(text) : null;
    if (!response.ok) {
      throw toApiError(response.status, payload, text);
    }
    return payload as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(
  status: number,
  payload: unknown,
  text: string,
): KanbioApiError {
  if (payload && typeof payload === 'object') {
    const body = payload as {
      message?: unknown;
      errors?: { path?: unknown[]; message?: unknown }[];
    };
    const message = Array.isArray(body.message)
      ? body.message.map(String).join('; ')
      : typeof body.message === 'string'
        ? body.message
        : `HTTP ${status}`;
    const details = (body.errors ?? []).map((error) => {
      const path = Array.isArray(error.path) ? error.path.join('.') : '';
      return path ? `${path}: ${String(error.message)}` : String(error.message);
    });
    return new KanbioApiError(status, message, details);
  }
  return new KanbioApiError(status, text.slice(0, 200) || `HTTP ${status}`);
}
