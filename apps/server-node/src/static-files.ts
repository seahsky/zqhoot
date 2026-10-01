import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MediaKey } from '@zqhoot/protocol';

const IMMUTABLE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/** Only these are served from `/media/*`; SVG and anything else are never uploaded (ADR-0011). */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface StaticHandlerOptions {
  webDist: string;
  dataDir: string;
  /** Added to every HTML response (ADR-0013). */
  htmlHeaders: Record<string, string>;
  runtimeConfig: string;
}

type HeaderMap = Record<string, string | number>;

function plain(res: ServerResponse, status: number, text: string, extra: HeaderMap = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(text);
}

/** A weak ETag is enough: it only decides between 200 and 304. */
const etagOf = (size: number, mtimeMs: number): string =>
  `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//, '') === etag.slice(2));
}

/** Streams `path` with `headers`. False when it is not a regular file. */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  headers: HeaderMap,
): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') return false;
    throw err;
  }
  if (!info.isFile()) return false;
  const etag = etagOf(info.size, info.mtimeMs);
  const all = { ...headers, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (matchesEtag(req.headers['if-none-match'], etag)) {
    res.writeHead(304, all);
    res.end();
    return true;
  }
  res.writeHead(200, { ...all, 'Content-Length': info.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // The client hanging up mid-file is not an error worth reporting.
  await pipeline(createReadStream(path), res).catch(() => undefined);
  return true;
}

/** The file for a request path inside `root`, or null for anything that could leave it. */
function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return null;
  const file = join(root, ...segments);
  const rel = relative(root, file);
  return rel.startsWith('..') || isAbsolute(rel) ? null : file;
}

/**
 * Everything the process serves besides `/api/*` and `/ws`: `/config.json`, `/media/*`, and the web
 * app with its SPA fallback. Returns a handler for GET/HEAD requests to those paths.
 */
export function createStaticHandler(opts: StaticHandlerOptions) {
  const indexHtml = join(opts.webDist, 'index.html');
  const noCache = { 'Cache-Control': 'no-cache' };

  async function config(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(opts.runtimeConfig),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : opts.runtimeConfig);
  }

  async function media(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    // The key format (no dots but the extension, no `..`) is what keeps the path inside the folder.
    const key = pathname.slice(1);
    const type = MediaKey.safeParse(key).success ? MEDIA_TYPES[extname(key)] : undefined;
    const file = type === undefined ? null : resolveInside(opts.dataDir, key);
    const sent =
      file !== null &&
      type !== undefined &&
      (await sendFile(req, res, file, {
        'Content-Type': type,
        'Cache-Control': IMMUTABLE,
        // Uploaded bytes are untrusted: even if a browser rendered one as a document it could not run script.
        'Content-Security-Policy': "default-src 'none'; sandbox",
      }));
    if (!sent) plain(res, 404, 'Not Found');
  }

  async function web(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const file = resolveInside(opts.webDist, pathname);
    if (file === null) {
      plain(res, 400, 'Bad Request');
      return;
    }
    const rel = relative(opts.webDist, file);
    // A misconfigured ZQ_WEB_DIST (the repository root, say) must not publish `.env` or `.git`.
    if (rel.split(sep).some((part) => part.startsWith('.') && part !== '.well-known')) {
      plain(res, 404, 'Not Found');
      return;
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers: HeaderMap = {
      'Content-Type': type,
      // Vite writes content hashes into everything under `assets/`.
      'Cache-Control': pathname.startsWith('/assets/') ? IMMUTABLE : 'no-cache',
      ...(type.startsWith('text/html') ? opts.htmlHeaders : {}),
    };
    if (await sendFile(req, res, file, headers)) return;

    // A path with a file extension is a missing file (a stale hashed asset, say); serving the app
    // shell for it would hand the browser HTML where it expects a script.
    if (basename(rel).includes('.')) {
      plain(res, 404, 'Not Found');
      return;
    }
    const served = await sendFile(req, res, indexHtml, {
      ...noCache,
      'Content-Type': CONTENT_TYPES['.html'] ?? 'text/html',
      ...opts.htmlHeaders,
    });
    if (!served) plain(res, 404, 'Not Found: the web app is not installed (see ZQ_WEB_DIST)');
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plain(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }
    if (pathname === '/config.json') return config(req, res);
    if (pathname === '/ws' || pathname.startsWith('/ws/')) {
      plain(res, 404, 'Not Found');
      return;
    }
    if (pathname === '/media' || pathname.startsWith('/media/')) return media(req, res, pathname);
    return web(req, res, pathname);
  };
}
