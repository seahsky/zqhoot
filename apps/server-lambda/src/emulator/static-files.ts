import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

async function fileAt(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built web app the way CloudFront + S3 would: hashed assets cached forever,
 * `index.html` revalidated, and extension-less paths answered with `index.html` for the SPA router.
 */
export function createStaticHandler(webDist: string) {
  const root = resolve(webDist);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return void res.end();
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://emulator').pathname);
    } catch {
      res.writeHead(400);
      return void res.end();
    }
    let file = resolve(join(root, pathname));
    // Anything that resolves outside the web root (`..`, encoded or not) is a plain 404.
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404);
      return void res.end();
    }
    if (!(await fileAt(file))) {
      const spaRoute = extname(pathname) === '';
      const index = join(root, 'index.html');
      if (!spaRoute || !(await fileAt(index))) {
        const built = await fileAt(index);
        res.writeHead(built ? 404 : 503, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end(
          built
            ? 'not found'
            : `web app is not built: nothing at ${root}. Run pnpm --filter @zqhoot/web build.`,
        );
      }
      file = index;
    }
    const immutable = file.startsWith(join(root, 'assets') + sep);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}
