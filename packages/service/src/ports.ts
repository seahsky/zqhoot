import type { OutboundMessage, UploadGrant, UploadRequest } from '@zqhoot/protocol';

export interface Transport {
  /** Serialise, stamp `ts` = clock.now() per recipient immediately before sending, send. Never throws for a gone peer. */
  send(
    batch: Array<{ connectionId: string; message: OutboundMessage }>,
  ): Promise<{ gone: string[] }>;
  close(connectionId: string, code?: number, reason?: string): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface Ids {
  sessionId(): string;
  playerId(): string;
  quizId(): string;
  /** 32 random bytes, base64url. */
  token(): string;
  /** 6 digits, first digit 1-9. */
  pin(): string;
  mediaId(): string;
}

export interface HostIdentity {
  hostId: string;
  displayName: string;
}

export interface HostAuth {
  /** Null when the token is invalid or expired. */
  verify(token: string): Promise<HostIdentity | null>;
}

export interface LocalLogin {
  login(username: string, password: string): Promise<{ token: string; expiresAt: number } | null>;
}

export interface MediaStorage {
  createUpload(host: HostIdentity, req: UploadRequest, now: number): Promise<UploadGrant>;
  /** VM only: verify the grant token for `key` and persist bytes; throws MediaError on type/size/token problems. */
  put?(
    key: string,
    token: string,
    contentType: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<void>;
}

export type MediaErrorKind = 'token' | 'type' | 'size' | 'key';

/** What `MediaStorage.put` throws for a request it refuses; the HTTP app maps `kind` to a status. */
export class MediaError extends Error {
  readonly kind: MediaErrorKind;
  constructor(kind: MediaErrorKind, message: string) {
    super(message);
    this.name = 'MediaError';
    this.kind = kind;
  }
}

export interface Warmer {
  warm(): Promise<void>;
}

/** VM only; the Lambda adapter passes a no-op. */
export interface Scheduler {
  scheduleClose(sessionId: string, questionIndex: number, at: number): void;
  cancel(sessionId: string): void;
}

export interface Logger {
  debug(o: object, m?: string): void;
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

export type Sleep = (ms: number) => Promise<void>;

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * WebSocket close codes the service passes to `Transport.close`. Standard codes only, so the
 * browser client can tell them apart from the `error` message that precedes each close.
 */
export const CLOSE_CODES = {
  normal: 1000,
  protocolError: 1002,
  policyViolation: 1008,
} as const;
