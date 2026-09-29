// Keeps credentials out of the results file (no k6 imports, so it runs under `node --test`).
//
// handleSummary receives everything k6 knows, including the return value of setup(), which carries
// the host's bearer token. On AWS that is a real Cognito ID token, and results files are meant to be
// committed. Two layers: drop the known field, then scrub anything that still looks like a token.

/** The fields of setup()'s return value that are credentials. */
const SETUP_SECRETS = ['token'];

/** k6's summary data without the credentials in `setup_data`. */
export function withoutSetupSecrets(data) {
  const setup = data.setup_data;
  if (setup === null || typeof setup !== 'object') return data;
  const safe = { ...setup };
  for (const key of SETUP_SECRETS) delete safe[key];
  return { ...data, setup_data: safe };
}

// A JSON Web Token: three base64url segments, the first two starting like `{"`. Cognito ID tokens
// and the local server's tokens both match.
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * Serialised JSON with every token replaced: the exact values in `known` (the token the operator
 * passed in) and anything shaped like a JWT. Tokens use no character that JSON escapes, so the
 * result is still valid JSON.
 */
export function redactTokens(text, known = []) {
  let out = text;
  for (const secret of known) {
    if (typeof secret === 'string' && secret.length >= 16) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out.replace(JWT, '[redacted]');
}
