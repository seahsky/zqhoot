// Everything the script needs from the environment, validated once at init. The script targets a
// deployment through these variables alone; nothing else changes between Node, the Lambda
// emulator and AWS.

const TIME_LIMITS_SEC = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

const fail = (message) => {
  throw new Error(`zqhoot load test configuration: ${message}`);
};

const text = (name, fallback = '') => {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
};

const number = (name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) => {
  const raw = text(name, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    fail(`${name}=${raw} is not ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  }
  return value;
};

const trimSlash = (url) => url.replace(/\/+$/, '');
const originOf = (url) => {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return match === null ? '' : match[1];
};

function build() {
  const baseUrl = trimSlash(text('ZQ_BASE_URL'));
  if (baseUrl === '') {
    fail('ZQ_BASE_URL is required (the site or server URL, e.g. http://127.0.0.1:8080)');
  }
  if (originOf(baseUrl) === '') fail(`ZQ_BASE_URL=${baseUrl} is not an http(s) URL`);

  // `cognito` is the ADR-0014 spelling of `token`.
  const rawMode = text('ZQ_AUTH_MODE', 'local');
  const authMode = rawMode === 'cognito' ? 'token' : rawMode;
  if (authMode !== 'local' && authMode !== 'token') {
    fail(`ZQ_AUTH_MODE=${rawMode} must be local or token`);
  }
  const hostToken = text('ZQ_HOST_TOKEN');
  if (authMode === 'token' && hostToken === '') fail('ZQ_AUTH_MODE=token needs ZQ_HOST_TOKEN');
  const username = text('ZQ_USERNAME', 'admin');
  const password = text('ZQ_PASSWORD');
  if (authMode === 'local' && password === '') fail('ZQ_AUTH_MODE=local needs ZQ_PASSWORD');

  const players = number('ZQ_PLAYERS', 400, { min: 1, max: 5000, integer: true });
  const questions = number('ZQ_QUESTIONS', 10, { min: 1, max: 100, integer: true });
  const timeLimit = number('ZQ_TIME_LIMIT', 20, { integer: true });
  if (!TIME_LIMITS_SEC.includes(timeLimit)) {
    fail(`ZQ_TIME_LIMIT=${timeLimit} must be one of ${TIME_LIMITS_SEC.join(', ')}`);
  }
  const joinRampSec = number('ZQ_JOIN_RAMP_SEC', 20, { min: 0 });
  const joinTimeoutSec = number('ZQ_JOIN_TIMEOUT_SEC', 90, { min: 1 });
  const dwellMs = number('ZQ_DWELL_MS', 1000, { min: 0 });

  // Generous on purpose: this only bounds a run that is stuck, never one that is merely slow.
  const stepBudgetSec = timeLimit + 12 + (dwellMs / 1000) * 2;
  const budgetSec = Math.ceil(joinRampSec + joinTimeoutSec + questions * stepBudgetSec + 60);

  return {
    target: text('ZQ_TARGET', 'custom'),
    runId: text('ZQ_RUN_ID'),
    baseUrl,
    apiUrl: trimSlash(text('ZQ_API_URL')),
    wsUrl: text('ZQ_WS_URL'),
    origin: text('ZQ_ORIGIN') || originOf(baseUrl),
    authMode,
    username,
    password,
    hostToken,
    players,
    questions,
    reconnectRatio: number('ZQ_RECONNECT_RATIO', 0.1, { min: 0, max: 1 }),
    timeLimit,
    readSeconds: number('ZQ_READ_SECONDS', 0, { min: 0, max: 10, integer: true }),
    seed: number('ZQ_SEED', 1, { integer: true }),
    joinRampSec,
    joinTimeoutSec,
    dwellMs,
    // Player think time after the question opens: log-normal, median 3 s, clipped.
    answerMedianSec: number('ZQ_ANSWER_MEDIAN_SEC', 3, { min: 0.1 }),
    answerSigma: number('ZQ_ANSWER_SIGMA', 0.5, { min: 0 }),
    firstOptionShare: number('ZQ_FIRST_OPTION_SHARE', 0.6, { min: 0, max: 1 }),
    // One planned disconnect per reconnecting player: it drops this long after it first sees the
    // question it was picked for, and comes back this long after dropping (seconds).
    dropDelaySec: [
      number('ZQ_DROP_DELAY_MIN_SEC', 0.3, { min: 0 }),
      number('ZQ_DROP_DELAY_MAX_SEC', 3, { min: 0 }),
    ],
    resumeDelaySec: [
      number('ZQ_RESUME_DELAY_MIN_SEC', 0.5, { min: 0 }),
      number('ZQ_RESUME_DELAY_MAX_SEC', 3, { min: 0 }),
    ],
    resumeRetries: number('ZQ_RESUME_RETRIES', 3, { min: 0, integer: true }),
    welcomeTimeoutMs: number('ZQ_WELCOME_TIMEOUT_MS', 15000, { min: 1000 }),
    stepTimeoutMs: number('ZQ_STEP_TIMEOUT_MS', 30000, { min: 1000 }),
    statsPollMs: 1000,
    budgetSec,
    resultsDir: text('ZQ_RESULTS_DIR', 'results'),
    commit: text('ZQ_COMMIT'),
    machine: text('ZQ_MACHINE'),
  };
}

export const cfg = build();

/** The configuration as recorded in a results file: no credentials. */
export const publicConfig = () => {
  const { password, hostToken, ...rest } = cfg;
  return rest;
};
