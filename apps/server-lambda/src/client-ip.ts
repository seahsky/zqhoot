import type { Context } from 'hono';
import type { LambdaEvent } from 'hono/aws-lambda';

/** `hono/aws-lambda` puts the raw API Gateway event on `c.env.event`. */
export function apiGatewayClientIp(c: Context): string | undefined {
  const event = (c.env as { event?: LambdaEvent } | undefined)?.event;
  if (event === undefined || !('requestContext' in event)) return undefined;
  const context = event.requestContext as { http?: { sourceIp?: string } };
  return context.http?.sourceIp;
}
