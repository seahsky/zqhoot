import { z } from 'zod';
import { Id, MediaKey, Phase, Pin } from './common.ts';
import { IMAGE_CONTENT_TYPES, LIMITS } from './limits.ts';

/**
 * HTTP API contract. Paths are relative to `apiBaseUrl` from the runtime config.
 * Host routes require `Authorization: Bearer <JWT>`.
 *
 *   GET    /api/health                          -> Health
 *   GET    /api/join/:pin                       -> PinLookupResponse          (public, rate limited)
 *   POST   /api/auth/login        LoginRequest  -> LoginResponse              (VM local auth only)
 *   GET    /api/me                              -> Me
 *   GET    /api/quizzes                         -> QuizSummary[]
 *   POST   /api/quizzes           QuizInput     -> Quiz
 *   GET    /api/quizzes/:id                     -> Quiz
 *   PUT    /api/quizzes/:id       QuizUpdate    -> Quiz                       (409 on version mismatch)
 *   DELETE /api/quizzes/:id                     -> 204
 *   POST   /api/quizzes/:id/duplicate           -> Quiz
 *   POST   /api/media/uploads     UploadRequest -> UploadGrant
 *   PUT    /api/media/:key...     <bytes>       -> 204                        (VM local media only)
 *   POST   /api/sessions          CreateSessionRequest -> CreateSessionResponse
 *   GET    /api/sessions                        -> SessionSummary[]
 *   GET    /api/sessions/:id/results.csv        -> text/csv
 *
 * Errors use HTTP status codes with an `ApiError` body.
 */

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  target: z.enum(['aws', 'vm']),
});

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const PinLookupResponse = z.object({
  sessionId: Id,
  quizTitle: z.string(),
  joinable: z.boolean(),
  reason: z.enum(['locked', 'ended', 'full']).optional(),
});
export type PinLookupResponse = z.infer<typeof PinLookupResponse>;

export const LoginRequest = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});
export const LoginResponse = z.object({ token: z.string(), expiresAt: z.number().int() });

export const Me = z.object({ hostId: z.string(), displayName: z.string() });

/** PUT body: the full quiz plus the version the editor loaded. */
export const QuizUpdate = z.object({
  expectedVersion: z.number().int().nonnegative(),
  // Kept as unknown here to avoid a cycle; the handler validates with QuizInput.
  quiz: z.unknown(),
});

export const UploadRequest = z.object({
  contentType: z.enum(IMAGE_CONTENT_TYPES),
  size: z.number().int().min(1).max(LIMITS.imageMaxBytes),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

/**
 * Either an S3 presigned POST (browser sends multipart form with `fields` then the file)
 * or a direct PUT to the VM server.
 */
export const UploadGrant = z.object({
  key: MediaKey,
  upload: z.discriminatedUnion('method', [
    z.object({
      method: z.literal('POST'),
      url: z.string().url(),
      fields: z.record(z.string(), z.string()),
    }),
    z.object({
      method: z.literal('PUT'),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
    }),
  ]),
  expiresAt: z.number().int(),
});
export type UploadGrant = z.infer<typeof UploadGrant>;

export const CreateSessionRequest = z.object({ quizId: Id });
export const CreateSessionResponse = z.object({ sessionId: Id, pin: Pin });
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const SessionSummary = z.object({
  sessionId: Id,
  pin: Pin,
  quizId: Id,
  quizTitle: z.string(),
  phase: Phase,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;
