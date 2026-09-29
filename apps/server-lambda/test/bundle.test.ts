import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const names = ['ws', 'http'] as const;

const MAX_ZIP_BYTES = 5 * 1024 * 1024;

interface Metafile {
  inputs: Record<string, unknown>;
}
const inputsOf = (name: string): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(join(dist, 'meta', `${name}.json`), 'utf8')) as Metafile).inputs,
  );

describe.each(names)('dist/%s.zip', (name) => {
  const zipPath = join(dist, `${name}.zip`);
  const entries = () => unzipSync(new Uint8Array(readFileSync(zipPath)));

  it('exists, is under 5 MB, and has index.mjs at the root (handler = index.handler)', () => {
    expect(statSync(zipPath).size).toBeLessThan(MAX_ZIP_BYTES);
    const files = Object.keys(entries());
    expect(files).toContain('index.mjs');
    // Nothing nested: the runtime looks for the handler file at the archive root.
    expect(files.filter((f) => f.includes('/'))).toEqual([]);
  });

  it('carries the source map next to the bundle, for --enable-source-maps', () => {
    const files = entries();
    expect(Object.keys(files)).toContain('index.mjs.map');
    const bundle = new TextDecoder().decode(files['index.mjs']);
    expect(bundle).toMatch(/\/\/# sourceMappingURL=index\.mjs\.map\s*$/);
  });

  it('holds exactly the bytes of the built bundle', () => {
    const inZip = entries()['index.mjs'] as Uint8Array;
    expect(Buffer.from(inZip).equals(readFileSync(join(dist, name, 'index.mjs')))).toBe(true);
  });

  it('is an ES module that bundles the AWS SDK (ADR-0010)', () => {
    const inputs = inputsOf(name);
    expect(inputs.some((i) => i.includes('@smithy/'))).toBe(true);
    expect(inputs.some((i) => i.includes('@aws-sdk/'))).toBe(true);
    // Only Node built-ins may stay external; the runtime's copy of the SDK is not relied on.
    const bundle = readFileSync(join(dist, name, 'index.mjs'), 'utf8');
    expect(bundle).not.toMatch(/from\s*["']@aws-sdk\//);
    expect(bundle).not.toMatch(/from\s*["']@zqhoot\//);
  });

  it('contains no ws, no test code and no emulator', () => {
    const bundle = readFileSync(join(dist, name, 'index.mjs'), 'utf8');
    expect(bundle).not.toMatch(/from\s*["']ws["']/);
    expect(bundle).not.toMatch(/require\(["']ws["']\)/);
    expect(bundle).not.toContain('Sec-WebSocket-Accept');

    const inputs = inputsOf(name);
    for (const banned of ['/node_modules/ws/', '@types/', 'src/emulator/']) {
      expect(inputs.filter((i) => i.includes(banned))).toEqual([]);
    }
    // Test files and fixtures live outside src/ and packages/*/src/.
    expect(inputs.filter((i) => /(^|\/)(test|tests|fixtures)\//.test(i))).toEqual([]);
    expect(inputs.filter((i) => /\.(test|spec)\.[cm]?[jt]s$/.test(i))).toEqual([]);
  });
});

describe('dist/ws/index.mjs and dist/http/index.mjs as Lambda would load them', () => {
  const env = {
    ZQ_TARGET: 'aws',
    ZQ_TABLE_NAME: 'zqhoot-bundle-check',
    ZQ_SITE_ORIGIN: 'https://quiz.example.com',
    ZQ_COGNITO_USER_POOL_ID: 'us-east-1_TestPool1',
    ZQ_COGNITO_CLIENT_ID: 'client-abc',
    ZQ_SESSION_TTL_DAYS: '30',
    ZQ_WS_CALLBACK_URL: 'https://abc.execute-api.us-east-1.amazonaws.com/prod',
    ZQ_MEDIA_BUCKET: 'zqhoot-media',
    ZQ_WS_FUNCTION_NAME: 'zqhoot-ws',
    ZQ_WARM_CONCURRENCY: '0',
    ZQ_LOG_LEVEL: 'error',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
  };

  type Handler = (
    event: unknown,
    context: unknown,
  ) => Promise<{ statusCode: number; body?: string }>;

  /** A plain file-URL import, so this is the bundle itself and not a transform of the source. */
  async function importHandler(name: (typeof names)[number]): Promise<Handler> {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const url = pathToFileURL(join(dist, name, 'index.mjs')).href;
      return ((await import(/* @vite-ignore */ url)) as { handler: Handler }).handler;
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it.each(names)('importing %s exposes a handler', async (name) => {
    expect(typeof (await importHandler(name))).toBe('function');
  });

  it('serves /api/health from the built http bundle with the packaged version', async () => {
    const handler = await importHandler('http');
    const result = await handler(
      {
        version: '2.0',
        routeKey: '$default',
        rawPath: '/api/health',
        rawQueryString: '',
        headers: {},
        requestContext: { http: { method: 'GET', path: '/api/health', sourceIp: '203.0.113.5' } },
        isBase64Encoded: false,
      },
      {},
    );
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(JSON.parse(result.body as string)).toEqual({ ok: true, version, target: 'aws' });
  });

  it('checks the Origin on $connect from the built ws bundle', async () => {
    const handler = await importHandler('ws');
    const connect = (origin: string) =>
      handler(
        {
          headers: { Origin: origin },
          requestContext: {
            routeKey: '$connect',
            connectionId: 'abc=',
            requestTimeEpoch: 1,
            identity: { sourceIp: '203.0.113.5' },
          },
        },
        {},
      );
    expect((await connect('https://quiz.example.com')).statusCode).toBe(200);
    expect((await connect('https://evil.example')).statusCode).toBe(403);
  });
});
