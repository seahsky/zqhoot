import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds once for the whole run: the bundle checks and the emulator tests need `dist/`, and
 * parallel test files must not each rebuild (the build starts by deleting it).
 */
export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
