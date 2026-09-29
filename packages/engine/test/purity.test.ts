import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('engine source stays pure (ADR-0001: no I/O, no clock, no randomness)', () => {
  it('scans every source file', () => {
    expect(files).toContain('index.ts');
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(files)('%s imports only @zqhoot/protocol, obscenity and sibling files', (file) => {
    const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
    const specifiers = [
      ...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1] as string);
    const bare = [...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1] as string,
    );
    for (const spec of [...specifiers, ...bare]) {
      const ok =
        spec === '@zqhoot/protocol' || spec === 'obscenity' || /^\.\/[\w-]+\.ts$/.test(spec);
      expect(ok, `${file} imports ${spec}`).toBe(true);
    }
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  const forbidden: Array<[string, RegExp]> = [
    ['node: modules', /['"]node:/],
    ['Date.now', /\bDate\s*\.\s*now\b/],
    ['new Date', /\bnew\s+Date\b/],
    ['Math.random', /\bMath\s*\.\s*random\b/],
    ['crypto', /crypto/i],
    ['performance', /\bperformance\b/],
    ['process', /\bprocess\b/],
    ['Buffer', /\bBuffer\b/],
    ['timers', /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/],
    ['network and console', /\b(?:fetch|XMLHttpRequest|WebSocket|console)\b/],
    ['fs and env', /\b(?:readFile|writeFile|localStorage|sessionStorage)\b/],
  ];
  it.each(files)('%s has no clock, randomness or I/O', (file) => {
    const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
    for (const [name, pattern] of forbidden) expect(code, `${file}: ${name}`).not.toMatch(pattern);
  });
});

describe('public API (the names the service layer codes against)', () => {
  const functions = [
    'normalizeNickname',
    'normalizeWord',
    'normalizeOpenText',
    'containsProfanity',
    'toPublicQuestion',
    'questionLimitMs',
    'isScoringQuestion',
    'basePoints',
    'streakBonus',
    'rankEntries',
    'createSession',
    'isExpired',
    'checkJoinable',
    'applyHostCommand',
    'timerClose',
    'evaluateAnswer',
    'computeReveal',
    'revealFromStored',
    'toPlayerResult',
    'buildQuestionMessage',
    'buildLeaderboard',
    'buildEnded',
    'buildRoster',
    'buildPlayerSnapshot',
    'buildHostSnapshot',
    'computeLiveStats',
    'buildResultsCsv',
  ];
  it.each(functions)('exports function %s', (name) => {
    expect(typeof (engine as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports DEFAULT_SESSION_TTL_MS as 30 days', () => {
    expect(engine.DEFAULT_SESSION_TTL_MS).toBe(30 * 24 * 3600 * 1000);
  });
});
