import { readFile } from 'node:fs/promises';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './cast.ts';
import { apiToken, signIn } from './host.ts';

/**
 * The results CSV must start with a UTF-8 byte order mark, so that spreadsheet apps read
 * non-ASCII nicknames correctly (the engine writes one). The mark has to survive two hops: the
 * server's reply and the dashboard's save. Both are checked on every target.
 */

const id = (tag: string) => tag.padEnd(21, 'x');

/** A session with no players is enough: the mark is the first three bytes of any export. */
async function sessionWithResults(request: APIRequestContext, name: string) {
  const title = `${name} ${Date.now().toString(36)}`;
  const token = await apiToken(request);
  const auth = { Authorization: `Bearer ${token}` };
  const quiz = await request.post('/api/quizzes', {
    headers: auth,
    data: {
      title,
      settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
      questions: [
        {
          id: id('bq1'),
          type: 'truefalse',
          prompt: 'Any statement',
          correct: true,
          points: 1,
          timeLimitSec: 10,
        },
      ],
    },
  });
  const { id: quizId } = (await quiz.json()) as { id: string };
  const created = await request.post('/api/sessions', { headers: auth, data: { quizId } });
  expect(created.ok()).toBe(true);
  const { sessionId } = (await created.json()) as { sessionId: string };
  return { auth, sessionId, title };
}

test('the server sends the CSV with a UTF-8 byte order mark', async ({ request }) => {
  // On the Lambda path this relies on `isContentTypeBinary` in apps/server-lambda/src/http.ts:
  // Hono's adapter would otherwise send the body through `Response.text()`, which drops the mark.
  const { auth, sessionId } = await sessionWithResults(request, 'BOM served quiz');
  const res = await request.get(`/api/sessions/${sessionId}/results.csv`, { headers: auth });
  expect(res.ok()).toBe(true);
  const bytes = await res.body();
  expect([...bytes.subarray(0, 3)], 'the first three bytes').toEqual([0xef, 0xbb, 0xbf]);
});

test('the CSV the dashboard saves keeps its UTF-8 byte order mark', async ({ cast, request }) => {
  // `net/http.ts` reads the reply with `Response.text()`, which drops the mark, so the
  // dashboard writes it back when it saves a CSV (`textFileBlob` in `net/hostApi.ts`). That makes
  // the saved file right on both targets, even where the server itself loses the mark.
  const { title } = await sessionWithResults(request, 'BOM saved quiz');

  const host = await cast.open('host', { viewport: { width: 1366, height: 768 } });
  await signIn(host.page, '/host');
  const [download] = await Promise.all([
    host.page.waitForEvent('download'),
    host.page.getByRole('button', { name: `Download results for ${title} as CSV` }).click(),
  ]);
  const saved = await readFile(await download.path());
  expect([...saved.subarray(0, 3)], 'the first three bytes of the saved file').toEqual([
    0xef, 0xbb, 0xbf,
  ]);
  expect([...saved.subarray(3, 6)], 'and only one mark').not.toEqual([0xef, 0xbb, 0xbf]);
});
