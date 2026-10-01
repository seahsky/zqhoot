// API and WebSocket half of deploy/vm/smoke-test.sh. It needs Node 22 or newer and nothing else:
// `fetch` and `WebSocket` are globals there.
//
//   node smoke-client.mjs play     log in, create a quiz and a session, connect a host and a player
//   node smoke-client.mjs resume   after the app restarted: everything is still there and `resume` works
//
// Settings come from the environment (the script is started by smoke-test.sh, not by hand):
//   ZQ_SMOKE_BASE      http://localhost:18080   where Caddy listens
//   ZQ_SMOKE_ORIGIN    http://localhost:18080   ZQ_PUBLIC_URL, sent as the WebSocket Origin like a browser would
//   ZQ_SMOKE_USER, ZQ_SMOKE_PASSWORD
//   ZQ_SMOKE_STATE     file that `play` writes and `resume` reads

import { readFile, writeFile } from 'node:fs/promises';

const PROTOCOL_VERSION = 1;
const TIMEOUT_MS = 10_000;

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const base = env('ZQ_SMOKE_BASE');
const origin = env('ZQ_SMOKE_ORIGIN');

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...headers,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login() {
  const res = await api('POST', '/api/auth/login', {
    body: { username: env('ZQ_SMOKE_USER'), password: env('ZQ_SMOKE_PASSWORD') },
  });
  check(res.status === 200 && typeof res.json?.token === 'string', 'host login returns a token');
  return res.json.token;
}

/** A WebSocket with an inbox of parsed server messages and a `next(type)` that waits for one. */
function connect(url, sendOrigin = origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: sendOrigin } });
    const inbox = [];
    let wake = () => {};
    const timer = setTimeout(
      () => reject(new Error(`no WebSocket open within ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
    ws.addEventListener('message', (event) => {
      inbox.push(JSON.parse(String(event.data)));
      wake();
    });
    ws.addEventListener('close', () => wake());
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connection failed'));
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        send: (message) => ws.send(JSON.stringify(message)),
        async next(type, where = () => true) {
          const deadline = Date.now() + TIMEOUT_MS;
          for (;;) {
            const index = inbox.findIndex((m) => m.type === type && where(m));
            if (index !== -1) return inbox.splice(index, 1)[0];
            if (Date.now() >= deadline || ws.readyState > WebSocket.OPEN) {
              throw new Error(
                `no '${type}' message (inbox: ${inbox.map((m) => m.type).join(', ') || 'empty'})`,
              );
            }
            await new Promise((done) => {
              wake = done;
              setTimeout(done, 200);
            });
          }
        },
      });
    });
  });
}

async function wsUrl() {
  const res = await api('GET', '/config.json');
  check(res.status === 200 && res.json?.target === 'vm', '/config.json says target "vm"');
  check(res.json.auth?.mode === 'local', '/config.json says local auth');
  check(
    res.json.wsUrl === `${origin.replace(/^http/, 'ws')}/ws`,
    `/config.json wsUrl is ${res.json.wsUrl}`,
  );
  return res.json.wsUrl;
}

// Four questions, so that the quiz as JSON is longer than Caddy's compression threshold (512 bytes):
// the check that API responses are not compressed would prove nothing on a shorter body.
const quiz = {
  title: 'Smoke test quiz',
  settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
  questions: ['question-one', 'question-two', 'question-three', 'question-four'].map((id) => ({
    id,
    type: 'single',
    prompt: `Pick A (${id})`,
    timeLimitSec: 10,
    options: [
      { id: 'opt-aaaaaa', text: 'A' },
      { id: 'opt-bbbbbb', text: 'B' },
    ],
    correctOptionId: 'opt-aaaaaa',
    points: 1,
  })),
};

async function play(statePath) {
  const wrong = await api('POST', '/api/auth/login', {
    body: { username: env('ZQ_SMOKE_USER'), password: `${env('ZQ_SMOKE_PASSWORD')}-wrong` },
  });
  check(wrong.status === 401, 'a wrong password is refused with 401');
  const token = await login();

  const unauthenticated = await api('GET', '/api/quizzes');
  check(unauthenticated.status === 401, 'host routes refuse a request without a token');

  const me = await api('GET', '/api/me', { token });
  check(
    me.status === 200 && me.json?.hostId?.startsWith('local:'),
    'GET /api/me identifies the host',
  );

  const created = await api('POST', '/api/quizzes', { token, body: quiz });
  check(created.status === 200 && typeof created.json?.id === 'string', 'a quiz is created');

  // The web app's static files are compressed (checked by smoke-test.sh); API responses, which
  // carry tokens and personal data, must not be, even when the client offers every encoding.
  const fetched = await api('GET', `/api/quizzes/${created.json.id}`, {
    token,
    headers: { 'Accept-Encoding': 'zstd, gzip' },
  });
  check(fetched.status === 200, 'the quiz is fetched back');
  check(
    !fetched.headers.has('content-encoding'),
    'an API response is not compressed, although the client accepts zstd and gzip',
  );
  check(
    fetched.text.length > 512,
    `that response (${fetched.text.length} bytes) is long enough for Caddy to have compressed it`,
  );
  const session = await api('POST', '/api/sessions', { token, body: { quizId: created.json.id } });
  check(
    session.status === 200 && /^\d{6}$/.test(session.json?.pin),
    'a session is created with a PIN',
  );
  const { sessionId, pin } = session.json;

  const lookup = await api('GET', `/api/join/${pin}`);
  check(lookup.status === 200 && lookup.json?.joinable === true, 'the PIN lookup says joinable');

  const url = await wsUrl();
  const host = await connect(url);
  host.send({
    type: 'host.hello',
    v: PROTOCOL_VERSION,
    sessionId,
    client: 'control',
    authToken: token,
  });
  const hostWelcome = await host.next('welcome');
  check(hostWelcome.role === 'host', 'a host WebSocket through Caddy is welcomed');

  const player = await connect(url);
  player.send({ type: 'join', v: PROTOCOL_VERSION, pin, nickname: 'Smoke' });
  const welcome = await player.next('welcome');
  check(
    welcome.role === 'player' &&
      welcome.credentials?.playerId &&
      welcome.snapshot?.phase === 'lobby',
    'a player joins through Caddy and lands in the lobby',
  );
  await host.next('roster', (m) => m.upsert.some((entry) => entry.nickname === 'Smoke'));
  check(true, 'the host is told about the new player');

  player.send({ type: 'ping', t: 1 });
  await player.next('pong');
  check(true, 'ping is answered with pong');

  let refused = false;
  try {
    await connect(url, 'https://evil.example');
  } catch {
    refused = true;
  }
  check(refused, 'a WebSocket from a foreign Origin is refused');

  player.ws.close();
  host.ws.close();
  await writeFile(
    statePath,
    JSON.stringify({ quizId: created.json.id, sessionId, pin, credentials: welcome.credentials }),
  );
}

async function resume(statePath) {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  const token = await login();

  const quizzes = await api('GET', '/api/quizzes', { token });
  check(
    quizzes.status === 200 && quizzes.json.some((q) => q.id === saved.quizId),
    'the quiz survived the restart (state.json in the volume)',
  );
  const lookup = await api('GET', `/api/join/${saved.pin}`);
  check(
    lookup.status === 200 && lookup.json?.sessionId === saved.sessionId,
    'the session survived the restart',
  );

  const player = await connect(await wsUrl());
  player.send({ type: 'resume', v: PROTOCOL_VERSION, ...saved.credentials });
  const welcome = await player.next('welcome');
  check(
    welcome.role === 'player' && welcome.snapshot?.phase === 'lobby',
    'the player resumes with the saved token',
  );
  player.ws.close();
}

const [command, statePath = env('ZQ_SMOKE_STATE')] = process.argv.slice(2);
const commands = { play, resume };
try {
  if (!(command in commands))
    throw new Error(`usage: smoke-client.mjs ${Object.keys(commands).join('|')}`);
  await commands[command](statePath);
  process.exit(0);
} catch (err) {
  console.error(`  FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
