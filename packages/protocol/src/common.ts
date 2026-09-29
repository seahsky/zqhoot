import { z } from 'zod';
import { LIMITS } from './limits.ts';

/** URL-safe random identifiers (nanoid alphabet). */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{6,32}$/, 'invalid id');
export type Id = z.infer<typeof Id>;

export const Pin = z.string().regex(new RegExp(`^[0-9]{${LIMITS.pinLength}}$`), 'invalid PIN');

/** Object key of an uploaded image, relative to the media base URL. */
export const MediaKey = z
  .string()
  .regex(
    /^media\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{6,32}\.(png|jpg|webp|gif)$/,
    'invalid media key',
  );

/** Epoch milliseconds on the server clock. */
export const EpochMs = z.number().int().nonnegative();

export const ErrorCode = z.enum([
  'bad-request',
  'protocol-version',
  'unauthorized',
  'forbidden',
  'not-found',
  'session-ended',
  'session-locked',
  'session-full',
  'nickname-invalid',
  'nickname-taken',
  'kicked',
  'rate-limited',
  'conflict',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Phase = z.enum(['lobby', 'question', 'revealing', 'reveal', 'leaderboard', 'ended']);
export type Phase = z.infer<typeof Phase>;
