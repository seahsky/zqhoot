import http from 'k6/http';
import { cfg } from './config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function must(res, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what} failed: HTTP ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * The HTTP API base and the WebSocket URL. Explicit environment values win; otherwise
 * `/config.json` of the site says where they are, as it does for the web app.
 */
export function discoverEndpoints() {
  let apiUrl = cfg.apiUrl;
  let wsUrl = cfg.wsUrl;
  if (apiUrl === '' || wsUrl === '') {
    const runtime = must(
      http.get(`${cfg.baseUrl}/config.json`, { tags: { name: 'GET /config.json' } }),
      `GET ${cfg.baseUrl}/config.json`,
    );
    if (apiUrl === '') apiUrl = typeof runtime.apiBaseUrl === 'string' ? runtime.apiBaseUrl : '';
    if (wsUrl === '') wsUrl = runtime.wsUrl;
  }
  if (apiUrl === '') apiUrl = cfg.baseUrl;
  if (typeof wsUrl !== 'string' || !/^wss?:\/\//.test(wsUrl)) {
    throw new Error(`no WebSocket URL: set ZQ_WS_URL (got ${wsUrl})`);
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ''), wsUrl };
}

/** The host's bearer token: a local login, or the ID token handed in through the environment. */
export function hostToken(apiUrl) {
  if (cfg.authMode === 'token') return cfg.hostToken;
  const res = http.post(
    `${apiUrl}/api/auth/login`,
    JSON.stringify({ username: cfg.username, password: cfg.password }),
    { headers: JSON_HEADERS, tags: { name: 'POST /api/auth/login' } },
  );
  return must(res, 'host login').token;
}

export function createQuizAndSession(apiUrl, token, quiz) {
  const headers = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
  const created = must(
    http.post(`${apiUrl}/api/quizzes`, JSON.stringify(quiz), {
      headers,
      tags: { name: 'POST /api/quizzes' },
    }),
    'create quiz',
  );
  return must(
    http.post(`${apiUrl}/api/sessions`, JSON.stringify({ quizId: created.id }), {
      headers,
      tags: { name: 'POST /api/sessions' },
    }),
    'create session',
  );
}

/** `GET /api/join/:pin`; the caller decides what a failure means. */
export function lookupPin(apiUrl, pin) {
  return http.get(`${apiUrl}/api/join/${pin}`, {
    timeout: '30s',
    tags: { name: 'GET /api/join/:pin' },
  });
}
