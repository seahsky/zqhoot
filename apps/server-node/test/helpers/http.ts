import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { TestServer } from './server.ts';

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

/**
 * A request whose path is sent exactly as given. `fetch` would normalise `/../` away before it
 * left the client, which is precisely what the traversal tests must not let happen. Every call
 * opens its own connection: a refusal may close the socket, and a pooled one would fail the next call.
 */
export function rawRequest(
  server: TestServer,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: Buffer | string | AsyncIterable<Buffer> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method, path, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    const body = opts.body;
    if (body === undefined || typeof body === 'string' || Buffer.isBuffer(body)) {
      req.end(body);
      return;
    }
    void (async () => {
      for await (const chunk of body) {
        if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
      }
      req.end();
    })().catch(reject);
  });
}
