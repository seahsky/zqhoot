import { ApiError } from '@zqhoot/protocol';

/** Anything with zod's `safeParse` shape; keeps zod itself out of this package's dependencies. */
export interface Parser<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

/**
 * Thrown for every failed request. `status` is 0 when no response arrived at all
 * (offline, DNS, CORS), and `error` is then `'network'`.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface RequestOptions<T> {
  /** JSON-encoded and sent with `Content-Type: application/json`. */
  body?: unknown;
  /** Validates the response body. Without it the parsed JSON is returned as `T` unchecked. */
  schema?: Parser<T>;
  /** How to read a 2xx body. Defaults to JSON; 204 always yields `undefined`. */
  responseType?: 'json' | 'text';
  signal?: AbortSignal;
  /** Overrides the client's token for this call; null sends no Authorization header. */
  token?: string | null;
}

export interface HttpClientOptions {
  /** `apiBaseUrl` from the runtime config; empty means same origin. */
  baseUrl: string;
  /** Bearer token source, read on every request (tokens refresh over time). */
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface HttpClient {
  request<T = unknown>(method: string, path: string, opts?: RequestOptions<T>): Promise<T>;
  get<T = unknown>(path: string, opts?: Omit<RequestOptions<T>, 'body'>): Promise<T>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions<T>, 'body'>,
  ): Promise<T>;
  put<T = unknown>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions<T>, 'body'>,
  ): Promise<T>;
  delete<T = unknown>(path: string, opts?: Omit<RequestOptions<T>, 'body'>): Promise<T>;
}

export function joinUrl(baseUrl: string, path: string): string {
  if (baseUrl === '') return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function failureFrom(res: Response): Promise<ApiRequestError> {
  let error = `http-${res.status}`;
  let message = res.statusText || `Request failed with status ${res.status}`;
  try {
    const parsed = ApiError.safeParse(await res.json());
    if (parsed.success) ({ error, message } = parsed.data);
  } catch {
    // Not JSON (a proxy error page, for example): keep the status-derived values.
  }
  return new ApiRequestError(res.status, error, message);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request<T>(method: string, path: string, opts: RequestOptions<T> = {}) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = opts.token === undefined ? (options.getToken?.() ?? null) : opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (opts.signal) init.signal = opts.signal;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await doFetch(joinUrl(options.baseUrl, path), init);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiRequestError(0, 'network', 'Could not reach the server.');
    }
    if (!res.ok) throw await failureFrom(res);
    if (res.status === 204) return undefined as T;

    if (opts.responseType === 'text') return (await res.text()) as T;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiRequestError(res.status, 'bad-response', 'The server sent an unreadable reply.');
    }
    if (!opts.schema) return json as T;
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiRequestError(res.status, 'bad-response', 'The server sent an unexpected reply.');
    }
    return parsed.data;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    put: (path, body, opts) => request('PUT', path, { ...opts, body }),
    delete: (path, opts) => request('DELETE', path, opts),
  };
}
