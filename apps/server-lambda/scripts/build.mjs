// Bundles the two Lambda handlers (and the local emulator) with esbuild and zips each handler
// directory into the package Terraform expects: dist/ws.zip and dist/http.zip (ADR-0010).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

// fflate writes DOS timestamps in local time; pinning the zone (with the fixed mtime below) makes
// the zips byte-identical between builds, so Terraform does not redeploy unchanged code.
process.env.TZ = 'UTC';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The two overrides exist for the build's own tests, which must not touch dist/ or need 5 MB.
const dist = resolve(process.env.ZQ_BUILD_OUT_DIR ?? join(root, 'dist'));
const MAX_ZIP_BYTES = Number(process.env.ZQ_BUILD_MAX_ZIP_BYTES ?? 5 * 1024 * 1024);
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Some bundled dependencies are CommonJS and call `require` for Node built-ins, which an ES
// module does not have.
const banner = `import { createRequire as __zqCreateRequire } from 'node:module';
const require = __zqCreateRequire(import.meta.url);`;

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  sourcemap: 'linked',
  legalComments: 'none',
  banner: { js: banner },
  define: { __ZQ_VERSION__: JSON.stringify(version) },
  metafile: true,
  logLevel: 'warning',
};

const handlers = [
  { name: 'ws', entry: 'src/ws.ts' },
  { name: 'http', entry: 'src/http.ts' },
];

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

if (process.env.ZQ_BUILD_OUT_DIR === undefined) {
  rmSync(dist, { recursive: true, force: true });
} else if (existsSync(dist) && readdirSync(dist).length > 0) {
  // Only the default dist/ is ours to empty.
  console.error(`ZQ_BUILD_OUT_DIR must be empty or missing: ${dist}`);
  process.exit(1);
}
mkdirSync(join(dist, 'meta'), { recursive: true });

let failed = false;

for (const { name, entry } of handlers) {
  const result = await build({
    ...common,
    entryPoints: { index: join(root, entry) },
    outdir: join(dist, name),
    minify: true,
  });
  writeFileSync(join(dist, 'meta', `${name}.json`), JSON.stringify(result.metafile));

  const files = Object.fromEntries(
    readdirSync(join(dist, name)).map((file) => [
      file,
      [
        readFileSync(join(dist, name, file)),
        { level: 9, mtime: FIXED_MTIME, os: 3, attrs: 0o644 << 16 },
      ],
    ]),
  );
  const zip = zipSync(files);
  writeFileSync(join(dist, `${name}.zip`), zip);

  const bundleBytes = statSync(join(dist, name, 'index.mjs')).size;
  const tooBig = zip.length > MAX_ZIP_BYTES;
  console.log(
    `${name}: index.mjs ${mb(bundleBytes)}, ${name}.zip ${mb(zip.length)} ` +
      `(${Object.keys(files).join(', ')})${tooBig ? `  FAIL: over ${mb(MAX_ZIP_BYTES)}` : ''}`,
  );
  if (tooBig) failed = true;
}

// The emulator runs on a developer machine, so `ws` stays a runtime dependency instead of being
// bundled. The handlers never import it.
await build({
  ...common,
  entryPoints: { main: join(root, 'src/emulator/main.ts') },
  outdir: join(dist, 'emulator'),
  external: ['ws'],
  minify: false,
});
console.log('emulator: dist/emulator/main.mjs');

if (failed) {
  console.error(`build failed: a zipped bundle is larger than ${mb(MAX_ZIP_BYTES)}`);
  process.exit(1);
}
