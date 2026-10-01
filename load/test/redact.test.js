import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { redactTokens, withoutSetupSecrets } from '../lib/redact.js';

// Header and payload of a real-looking ID token; the signature is made up.
const JWT =
  'eyJraWQiOiJhYmMiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJodHRwczovL2NvZ25pdG8ifQ.c2lnbmF0dXJl';

test('withoutSetupSecrets drops the host token and keeps the rest of setup_data', () => {
  const data = {
    metrics: { a: 1 },
    setup_data: { token: JWT, pin: '123456', sessionId: 's1', scored: [true, false] },
  };
  const safe = withoutSetupSecrets(data);
  assert.deepEqual(safe.setup_data, { pin: '123456', sessionId: 's1', scored: [true, false] });
  assert.deepEqual(safe.metrics, { a: 1 });
  assert.equal(JSON.stringify(safe).includes(JWT), false);
});

test('withoutSetupSecrets leaves its input alone', () => {
  const data = { setup_data: { token: JWT, pin: '1' } };
  withoutSetupSecrets(data);
  assert.equal(data.setup_data.token, JWT);
});

test('withoutSetupSecrets copes with a run that has no setup_data', () => {
  assert.deepEqual(withoutSetupSecrets({ metrics: {} }), { metrics: {} });
  assert.deepEqual(withoutSetupSecrets({ setup_data: null }), { setup_data: null });
});

test('redactTokens removes the operator-supplied token wherever it appears', () => {
  const opaque = 'not-a-jwt-but-still-a-secret-token-0123456789';
  const text = JSON.stringify({ a: { note: `Bearer ${opaque}` }, b: [opaque] });
  const out = redactTokens(text, [opaque]);
  assert.equal(out.includes(opaque), false);
  assert.doesNotThrow(() => JSON.parse(out));
});

test('redactTokens removes anything shaped like a JWT, whoever put it there', () => {
  const text = JSON.stringify({ deep: { nested: [{ value: JWT }] } });
  const out = redactTokens(text);
  assert.equal(out.includes('eyJ'), false);
  assert.deepEqual(JSON.parse(out), { deep: { nested: [{ value: '[redacted]' }] } });
});

test('redactTokens ignores empty and short known values instead of mangling the JSON', () => {
  const text = JSON.stringify({ players: 400, pin: '123456' });
  assert.equal(redactTokens(text, ['', undefined, '400']), text);
});

// The results files are committed; none may carry a credential (review finding R1-01).
test('no committed results file contains a token', () => {
  const dir = new URL('../results/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, 'expected results files to check');
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    assert.equal(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(text), false, `${name} has a JWT`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.k6?.setup_data?.token, undefined, `${name} has setup_data.token`);
  }
});
