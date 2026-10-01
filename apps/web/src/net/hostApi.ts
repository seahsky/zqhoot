import {
  CreateSessionRequest,
  CreateSessionResponse,
  Id,
  Quiz,
  QuizInput,
  QuizSummary,
  QuizUpdate,
  SessionSummary,
  UploadGrant,
  UploadRequest,
} from '@zqhoot/protocol';
import { ApiRequestError, createHttpClient } from './http.ts';
import type { Parser } from './http.ts';

/**
 * The host's HTTP API (`packages/protocol/src/http.ts`): every body is validated with the
 * protocol schema before it leaves, every reply after it arrives, and ids are checked before
 * they become part of a path.
 */

export interface HostApi {
  listQuizzes(): Promise<QuizSummary[]>;
  getQuiz(id: string): Promise<Quiz>;
  createQuiz(input: QuizInput): Promise<Quiz>;
  /** 409 comes back as `ApiRequestError` with `status === 409`. */
  updateQuiz(id: string, expectedVersion: number, input: QuizInput): Promise<Quiz>;
  deleteQuiz(id: string): Promise<void>;
  duplicateQuiz(id: string): Promise<Quiz>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(quizId: string): Promise<CreateSessionResponse>;
  /** The CSV text; the caller saves it, because a plain link cannot carry the auth header. */
  downloadResults(sessionId: string): Promise<string>;
  /**
   * The first request of an image upload (`POST /api/media/uploads`). It goes through the same
   * 401 refresh and retry as every other call; the second request, to the grant's own URL, is
   * signed by the grant and carries no bearer.
   */
  requestUpload(request: UploadRequest): Promise<UploadGrant>;
}

export interface HostApiOptions {
  baseUrl: string;
  getToken: () => string | null;
  /**
   * Called on a 401. Return true to retry the request once (a refreshed token), false to give
   * up (the host has been signed out).
   */
  onUnauthorized?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

/** A reply that is a JSON array of `T`. The web package has no direct zod dependency. */
export function listOf<T>(item: Parser<T>): Parser<T[]> {
  return {
    safeParse(data) {
      if (!Array.isArray(data)) return { success: false, error: { message: 'expected a list' } };
      const out: T[] = [];
      for (const entry of data) {
        const parsed = item.safeParse(entry);
        if (!parsed.success) return { success: false, error: parsed.error };
        out.push(parsed.data);
      }
      return { success: true, data: out };
    },
  };
}

function checkedId(id: string): string {
  if (!Id.safeParse(id).success) {
    throw new ApiRequestError(0, 'invalid-request', 'That id is not valid.');
  }
  return encodeURIComponent(id);
}

/** Validates a request body; a failure here is a bug in the caller, not a server error. */
function body<T>(schema: Parser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiRequestError(
      0,
      'invalid-request',
      `The request was not valid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function createHostApi(o: HostApiOptions): HostApi {
  const http = createHttpClient({
    baseUrl: o.baseUrl,
    getToken: o.getToken,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });

  async function call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401 && o.onUnauthorized) {
        if (await o.onUnauthorized()) return run();
      }
      throw err;
    }
  }

  return {
    listQuizzes: () => call(() => http.get('/api/quizzes', { schema: listOf(QuizSummary) })),
    getQuiz: (id) => call(() => http.get(`/api/quizzes/${checkedId(id)}`, { schema: Quiz })),
    createQuiz: (input) =>
      call(() => http.post('/api/quizzes', body(QuizInput, input), { schema: Quiz })),
    updateQuiz: (id, expectedVersion, input) =>
      call(() =>
        http.put(
          `/api/quizzes/${checkedId(id)}`,
          body(QuizUpdate, { expectedVersion, quiz: body(QuizInput, input) }),
          { schema: Quiz },
        ),
      ),
    deleteQuiz: (id) => call(() => http.delete(`/api/quizzes/${checkedId(id)}`)),
    duplicateQuiz: (id) =>
      call(() => http.post(`/api/quizzes/${checkedId(id)}/duplicate`, undefined, { schema: Quiz })),
    listSessions: () => call(() => http.get('/api/sessions', { schema: listOf(SessionSummary) })),
    createSession: (quizId) =>
      call(() =>
        http.post('/api/sessions', body(CreateSessionRequest, { quizId }), {
          schema: CreateSessionResponse,
        }),
      ),
    requestUpload: (request) =>
      call(() =>
        http.post('/api/media/uploads', body(UploadRequest, request), { schema: UploadGrant }),
      ),
    downloadResults: (sessionId) =>
      call(() =>
        http.get<string>(`/api/sessions/${checkedId(sessionId)}/results.csv`, {
          responseType: 'text',
          accept: 'text/csv',
        }),
      ),
  };
}

/** The UTF-8 byte order mark: spreadsheet apps read it as "this file is UTF-8, not a legacy code page". */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * The file's contents as a blob. `Response.text()` drops a leading byte order mark, so the CSV
 * the server sends (with one) reaches here without it. A CSV is written back with the mark, so
 * that nicknames with accents or emoji open correctly in a spreadsheet.
 */
export function textFileBlob(text: string, mime = 'text/csv'): Blob {
  const body =
    mime === 'text/csv' && !text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK + text : text;
  return new Blob([body], { type: `${mime};charset=utf-8` });
}

/** Saves text as a file. The link is clicked while attached because Firefox ignores a detached one. */
export function saveTextFile(name: string, text: string, mime = 'text/csv'): void {
  const url = URL.createObjectURL(textFileBlob(text, mime));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
