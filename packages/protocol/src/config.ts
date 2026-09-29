import { z } from 'zod';

/**
 * Served at `/config.json` next to the web app, generated per deployment
 * (Terraform on AWS, the Node server at startup on the VM). Public values only:
 * nothing in here is secret (ADR-0013).
 */
export const RuntimeConfig = z.object({
  target: z.enum(['aws', 'vm']),
  /** Prefix for HTTP API calls. Empty string means same origin. */
  apiBaseUrl: z.string(),
  /** Absolute wss:// (or ws:// in local dev) URL of the realtime endpoint. */
  wsUrl: z.string(),
  /** Prefix that media keys are appended to, e.g. `https://example.com/`. */
  mediaBaseUrl: z.string(),
  /** Public URL players open to join; the PIN is appended as `?pin=`. Shown as text and QR. */
  joinUrl: z.string(),
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('local') }),
    z.object({
      mode: z.literal('cognito'),
      region: z.string(),
      userPoolId: z.string(),
      clientId: z.string(),
      /** Managed login domain, e.g. `https://zqhoot-abc.auth.us-east-1.amazoncognito.com`. */
      domain: z.string().url(),
    }),
  ]),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;
