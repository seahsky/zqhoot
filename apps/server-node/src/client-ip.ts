import type { IncomingMessage } from 'node:http';

const FORWARDED_HOP = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * The address rate limits and logs attribute a request to. Behind a proxy we trust (`ZQ_TRUST_PROXY`,
 * Caddy) it is the first `X-Forwarded-For` hop; otherwise the header is ignored, because anyone
 * can send it.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
    if (first !== undefined && FORWARDED_HOP.test(first)) return stripMappedPrefix(first);
  }
  const address = req.socket.remoteAddress;
  return address === undefined ? undefined : stripMappedPrefix(address);
}

const stripMappedPrefix = (address: string): string => address.replace(/^::ffff:/i, '');
