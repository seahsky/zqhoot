import { describe, expect, it } from 'vitest';
import { PinLookupResponse } from '@zqhoot/protocol';
import { ApiRequestError, createHttpClient, joinUrl } from '../src/net/http.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('joinUrl', () => {
  it('handles same-origin and prefixed bases without doubling slashes', () => {
    expect(joinUrl('', '/api/health')).toBe('/api/health');
    expect(joinUrl('https://api.example', '/api/health')).toBe('https://api.example/api/health');
    expect(joinUrl('https://api.example/', '/api/health')).toBe('https://api.example/api/health');
    expect(joinUrl('/v1', 'api/health')).toBe('/v1/api/health');
  });
});

describe('HTTP client', () => {
  it('sends JSON bodies with a content type, and the bearer token from getToken', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ ok: true }));
    let token = 'first';
    const http = createHttpClient({ baseUrl: '', fetchImpl, getToken: () => token });
    await http.post('/api/quizzes', { title: 'Quiz' });
    token = 'second';
    await http.get('/api/me');

    expect(calls[0]!.url).toBe('/api/quizzes');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"title":"Quiz"}');
    expect(calls[0]!.init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer first',
    });
    expect(calls[1]!.init.headers).toMatchObject({ Authorization: 'Bearer second' });
    expect(calls[1]!.init.body).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sends no Authorization header without a token, and a per-call token can override or omit', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({}));
    const http = createHttpClient({ baseUrl: '', fetchImpl, getToken: () => 'default' });
    await http.get('/a', { token: 'override' });
    await http.get('/b', { token: null });
    const anon = createHttpClient({ baseUrl: '', fetchImpl });
    await anon.get('/c');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer override' });
    expect(calls[1]!.init.headers).not.toHaveProperty('Authorization');
    expect(calls[2]!.init.headers).not.toHaveProperty('Authorization');
  });

  it('prefixes the configured base URL', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({}));
    await createHttpClient({ baseUrl: 'https://api.example', fetchImpl }).get('/api/join/123456');
    expect(calls[0]!.url).toBe('https://api.example/api/join/123456');
  });

  it('validates the body against a protocol schema', async () => {
    const good = { sessionId: 'session-demo-01', quizTitle: 'Trivia', joinable: true };
    const http = createHttpClient({
      baseUrl: '',
      fetchImpl: fakeFetch(() => json(good)).fetchImpl,
    });
    expect(await http.get('/api/join/123456', { schema: PinLookupResponse })).toEqual(good);

    const bad = createHttpClient({
      baseUrl: '',
      fetchImpl: fakeFetch(() => json({ nope: true })).fetchImpl,
    });
    await expect(bad.get('/api/join/123456', { schema: PinLookupResponse })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 200,
      error: 'bad-response',
    });
  });

  it('throws ApiRequestError with the server ApiError body on failure', async () => {
    const http = createHttpClient({
      baseUrl: '',
      fetchImpl: fakeFetch(() => json({ error: 'not-found', message: 'No such game.' }, 404))
        .fetchImpl,
    });
    const err = await http.get('/api/join/000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 404, error: 'not-found', message: 'No such game.' });
  });

  it('falls back to status-derived values when the error body is not an ApiError', async () => {
    const html = fakeFetch(
      () => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const err = await createHttpClient({ baseUrl: '', fetchImpl: html.fetchImpl })
      .get('/x')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, error: 'http-502', message: 'Bad Gateway' });
  });

  it('reports a network failure as status 0', async () => {
    const http = createHttpClient({
      baseUrl: '',
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    await expect(http.get('/x')).rejects.toMatchObject({ status: 0, error: 'network' });
  });

  it('lets an abort through untouched', async () => {
    const http = createHttpClient({
      baseUrl: '',
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as typeof fetch,
    });
    await expect(http.get('/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns undefined for 204 and text for text responses', async () => {
    const empty = createHttpClient({
      baseUrl: '',
      fetchImpl: fakeFetch(() => new Response(null, { status: 204 })).fetchImpl,
    });
    expect(await empty.delete('/api/quizzes/abc')).toBeUndefined();

    const csv = createHttpClient({
      baseUrl: '',
      fetchImpl: fakeFetch(() => new Response('a,b\n1,2\n', { status: 200 })).fetchImpl,
    });
    expect(await csv.get<string>('/api/sessions/x/results.csv', { responseType: 'text' })).toBe(
      'a,b\n1,2\n',
    );
  });

  it('reports an unreadable success body', async () => {
    const http = createHttpClient({
      baseUrl: '',
      fetchImpl: fakeFetch(() => new Response('not json', { status: 200 })).fetchImpl,
    });
    await expect(http.get('/x')).rejects.toMatchObject({ error: 'bad-response' });
  });
});
