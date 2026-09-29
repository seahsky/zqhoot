import { describe, expect, it } from 'vitest';
import { QuizSummary } from '@zqhoot/protocol';
import { EDIT_QUIZ } from '../src/dev/fixtures/edit.ts';
import { ApiRequestError } from '../src/net/http.ts';
import { createHostApi, listOf } from '../src/net/hostApi.ts';
import { validateDraft } from '../src/state/editor.ts';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeApi(
  responder: (call: Call) => Response,
  over: { token?: () => string | null; onUnauthorized?: () => Promise<boolean> } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  const api = createHostApi({
    baseUrl: '',
    getToken: over.token ?? (() => 'TOKEN'),
    ...(over.onUnauthorized ? { onUnauthorized: over.onUnauthorized } : {}),
    fetchImpl,
  });
  return { api, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const validInput = () => {
  const r = validateDraft({ ...EDIT_QUIZ });
  if (!r.ok) throw new Error('fixture should be valid');
  return r.input;
};

const quizReply = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-demo-0001',
  ownerId: 'local:admin',
  version: 2,
  createdAt: 1,
  updatedAt: 2,
  ...validInput(),
  ...over,
});

describe('the host API', () => {
  it('lists quizzes and sessions with the bearer, and checks every item of the reply', async () => {
    const { api, calls } = fakeApi((c) =>
      c.url.endsWith('/quizzes')
        ? json([{ id: 'quiz-demo-0001', title: 'A', questionCount: 3, updatedAt: 5, version: 1 }])
        : json([]),
    );
    expect(await api.listQuizzes()).toHaveLength(1);
    expect(await api.listSessions()).toEqual([]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/quizzes' });
    expect(calls[0]?.headers.Authorization).toBe('Bearer TOKEN');

    const bad = fakeApi(() => json([{ id: 'quiz-demo-0001', title: 5 }]));
    await expect(bad.api.listQuizzes()).rejects.toMatchObject({ error: 'bad-response' });
    const notAList = fakeApi(() => json({ quizzes: [] }));
    await expect(notAList.api.listQuizzes()).rejects.toMatchObject({ error: 'bad-response' });
  });

  it('creates with POST and updates with PUT and expectedVersion', async () => {
    const { api, calls } = fakeApi(() => json(quizReply(), 200));
    await api.createQuiz(validInput());
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/quizzes' });
    await api.updateQuiz('quiz-demo-0001', 4, validInput());
    expect(calls[1]).toMatchObject({ method: 'PUT', url: '/api/quizzes/quiz-demo-0001' });
    expect(calls[1]?.body).toMatchObject({
      expectedVersion: 4,
      quiz: { title: 'Friday night trivia' },
    });
  });

  it('refuses a body the protocol would reject, without sending it', async () => {
    const { api, calls } = fakeApi(() => json(quizReply()));
    const broken = { ...validInput(), title: '' };
    await expect(api.createQuiz(broken)).rejects.toMatchObject({ error: 'invalid-request' });
    await expect(api.updateQuiz('quiz-demo-0001', 1, broken)).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    await expect(api.updateQuiz('quiz-demo-0001', -1, validInput())).rejects.toMatchObject({
      error: 'invalid-request',
    });
    await expect(api.createSession('not a valid id!')).rejects.toMatchObject({
      error: 'invalid-request',
    });
    expect(calls).toHaveLength(0);
  });

  it('checks ids before they become part of a path', async () => {
    const { api, calls } = fakeApi(() => json(quizReply()));
    for (const id of ['../admin', 'a b', 'x'.repeat(40), '', 'ab/c']) {
      await expect(api.getQuiz(id), id).rejects.toMatchObject({ error: 'invalid-request' });
      await expect(api.deleteQuiz(id), id).rejects.toBeInstanceOf(ApiRequestError);
    }
    expect(calls).toHaveLength(0);
    await api.duplicateQuiz('quiz-demo-0001');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/quizzes/quiz-demo-0001/duplicate',
    });
  });

  it('deletes with 204 and starts a session with the quiz id', async () => {
    const { api, calls } = fakeApi((c) =>
      c.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ sessionId: 'session-demo-01', pin: '482915' }),
    );
    await api.deleteQuiz('quiz-demo-0001');
    expect(await api.createSession('quiz-demo-0001')).toEqual({
      sessionId: 'session-demo-01',
      pin: '482915',
    });
    expect(calls[1]?.body).toEqual({ quizId: 'quiz-demo-0001' });
  });

  it('fetches the results as text, asking for CSV', async () => {
    const { api, calls } = fakeApi(
      () =>
        new Response('nickname,score\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }),
    );
    expect(await api.downloadResults('session-demo-01')).toBe('nickname,score\n');
    expect(calls[0]?.headers.Accept).toBe('text/csv');
    expect(calls[0]?.url).toBe('/api/sessions/session-demo-01/results.csv');
  });

  it('a 409 on save comes through with its status, for the conflict screen', async () => {
    const { api } = fakeApi(() => json({ error: 'conflict', message: 'Version mismatch.' }, 409));
    await expect(api.updateQuiz('quiz-demo-0001', 1, validInput())).rejects.toMatchObject({
      status: 409,
      error: 'conflict',
    });
  });

  it('retries once with a fresh token after a 401, and gives up when the sign-in cannot be mended', async () => {
    let token = 'OLD';
    let attempts = 0;
    const { api, calls } = fakeApi(
      (c) => {
        attempts += 1;
        return c.headers.Authorization === 'Bearer NEW'
          ? json([])
          : json({ error: 'unauthorized', message: 'expired' }, 401);
      },
      {
        token: () => token,
        onUnauthorized: async () => {
          token = 'NEW';
          return true;
        },
      },
    );
    expect(await api.listSessions()).toEqual([]);
    expect(attempts).toBe(2);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer OLD', 'Bearer NEW']);

    const stuck = fakeApi(() => json({ error: 'unauthorized', message: 'no' }, 401), {
      onUnauthorized: async () => false,
    });
    await expect(stuck.api.listSessions()).rejects.toMatchObject({ status: 401 });
    expect(stuck.calls).toHaveLength(1);
  });

  it('listOf reports the first bad item', () => {
    const parser = listOf(QuizSummary);
    expect(parser.safeParse([]).success).toBe(true);
    expect(parser.safeParse('nope').success).toBe(false);
    expect(
      parser.safeParse([
        { id: 'quiz-demo-0001', title: 'A', questionCount: 1, updatedAt: 1, version: 1 },
        {},
      ]).success,
    ).toBe(false);
  });
});
