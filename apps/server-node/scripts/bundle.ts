import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Bundles the server and the hash-password CLI into `outdir` (`server.mjs`, `hash-password.mjs`)
 * with every dependency inlined: the Docker image carries no `node_modules`.
 */
export async function bundle(outdir: string, logLevel: 'info' | 'silent' = 'info'): Promise<void> {
  const out = resolve(packageRoot, outdir);
  await rm(out, { recursive: true, force: true });
  await build({
    absWorkingDir: packageRoot,
    entryPoints: { server: 'src/main.ts', 'hash-password': 'cli/hash-password.ts' },
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    // CommonJS dependencies (`ws`) call `require`, which an ES module does not have.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    // `ws` loads these optional native speed-ups inside a try/catch and works without them.
    external: ['bufferutil', 'utf-8-validate'],
    logLevel,
  });
}
