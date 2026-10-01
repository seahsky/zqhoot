import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@zqhoot/service';
import { cleanIp } from './ws-gateway.ts';

/** API Gateway HTTP APIs reject payloads above 10 MB. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface HttpApiEvent {
  version: '2.0';
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  cookies?: string[];
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: Record<string, unknown>;
  body?: string;
  isBase64Encoded: boolean;
}

export interface HttpApiResult {
  statusCode?: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

export type HttpInvoker = (event: HttpApiEvent) => Promise<HttpApiResult>;

/** HTTP APIs hand text-like bodies over as-is and base64-encode the rest. */
const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.+\+(json|xml))/i;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function requestTime(epoch: number): string {
  const d = new Date(epoch);
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${two(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
  return `${date}:${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks);
}

/** Payload format 2.0, as API Gateway builds it for a `$default` route. */
export async function toHttpApiEvent(
  req: IncomingMessage,
  domainName: string,
): Promise<HttpApiEvent | 'too-large'> {
  const url = new URL(req.url ?? '/', 'http://emulator');
  const rawPath = req.url?.split('?')[0] ?? '/';
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(',') : value;
  }
  const cookies = headers.cookie?.split(/;\s*/).filter((c) => c !== '');
  delete headers.cookie;

  const query: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys()))
    query[key] = url.searchParams.getAll(key).join(',');

  const body = await readBody(req);
  if (body === null) return 'too-large';
  const contentType = headers['content-type'] ?? '';
  const binary = body.length > 0 && !TEXTUAL.test(contentType);
  const now = Date.now();

  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: url.search.replace(/^\?/, ''),
    ...(cookies !== undefined && cookies.length > 0 ? { cookies } : {}),
    headers,
    ...(Object.keys(query).length > 0 ? { queryStringParameters: query } : {}),
    requestContext: {
      accountId: '123456789012',
      apiId: 'emulator',
      domainName,
      domainPrefix: domainName.split('.')[0],
      http: {
        method: req.method ?? 'GET',
        path: rawPath,
        protocol: `HTTP/${req.httpVersion}`,
        sourceIp: cleanIp(req.socket.remoteAddress),
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: randomBytes(8).toString('hex'),
      routeKey: '$default',
      stage: '$default',
      time: requestTime(now),
      timeEpoch: now,
    },
    ...(body.length > 0 ? { body: binary ? body.toString('base64') : body.toString('utf8') } : {}),
    isBase64Encoded: binary,
  };
}

export function writeHttpApiResult(res: ServerResponse, result: HttpApiResult): void {
  const body =
    result.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(result.body, result.isBase64Encoded === true ? 'base64' : 'utf8');
  const headers: Record<string, string | string[]> = { ...result.headers };
  if (result.cookies !== undefined && result.cookies.length > 0)
    headers['set-cookie'] = result.cookies;
  res.writeHead(result.statusCode ?? 200, { ...headers, 'content-length': body.length });
  res.end(body);
}

/** `/api/*` goes to the built http handler, as the browser reaches the HTTP API directly on AWS. */
export function createApiHandler(opts: {
  invoke: HttpInvoker;
  domainName: string;
  logger: Logger;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const event = await toHttpApiEvent(req, opts.domainName);
      if (event === 'too-large') {
        res.writeHead(413, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ message: 'Request Entity Too Large' }));
      }
      writeHttpApiResult(res, await opts.invoke(event));
    } catch (err) {
      opts.logger.error({ err: String(err) }, 'http invocation failed');
      if (!res.headersSent) {
        // What API Gateway answers when the function itself fails.
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      }
    }
  };
}
