import { noopLogger } from '@zqhoot/service';
import type { GameService, Logger } from '@zqhoot/service';

/**
 * The parts of an API Gateway WebSocket proxy event this adapter reads. `@types/aws-lambda` omits
 * `identity` and `headers`, which the real event carries.
 */
export interface WebSocketEvent {
  headers?: Record<string, string | undefined>;
  body?: string | null;
  requestContext: {
    routeKey: string;
    connectionId: string;
    /** Epoch ms at which API Gateway received the frame (ADR-0005). */
    requestTimeEpoch: number;
    identity?: { sourceIp?: string };
  };
}

export interface WarmupEvent {
  warmup: true;
}

export interface HandlerResult {
  statusCode: number;
}

export type WsService = Pick<GameService, 'onConnect' | 'onDisconnect' | 'onMessage' | 'warm'>;

export interface WsHandlerDeps {
  service: WsService;
  logger?: Logger;
  /** Overridable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Long enough for concurrent warm-up invocations to land on separate environments (ADR-0010). */
export const WARMUP_HOLD_MS = 200;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isWarmup = (event: unknown): event is WarmupEvent =>
  typeof event === 'object' && event !== null && (event as { warmup?: unknown }).warmup === true;

const OK: HandlerResult = { statusCode: 200 };

export function createWsHandler(deps: WsHandlerDeps) {
  const { service } = deps;
  const log = deps.logger ?? noopLogger;
  const sleep = deps.sleep ?? defaultSleep;

  return async (event: WebSocketEvent | WarmupEvent): Promise<HandlerResult> => {
    if (isWarmup(event)) {
      await service.warm();
      await sleep(WARMUP_HOLD_MS);
      return OK;
    }
    const ctx = event.requestContext;
    if (ctx === undefined) {
      log.warn({}, 'event is neither a warm-up nor a WebSocket event');
      return { statusCode: 400 };
    }
    const sourceIp = ctx.identity?.sourceIp;

    switch (ctx.routeKey) {
      case '$connect': {
        const origin = event.headers?.origin ?? event.headers?.Origin;
        const { accept } = await service.onConnect(ctx.connectionId, {
          ...(origin !== undefined ? { origin } : {}),
          ...(sourceIp !== undefined ? { sourceIp } : {}),
        });
        return { statusCode: accept ? 200 : 403 };
      }
      case '$disconnect':
        await guarded(() => service.onDisconnect(ctx.connectionId), ctx.connectionId);
        return OK;
      default:
        await guarded(
          () =>
            service.onMessage(
              ctx.connectionId,
              event.body ?? '',
              ctx.requestTimeEpoch,
              sourceIp !== undefined ? { sourceIp } : {},
            ),
          ctx.connectionId,
        );
        return OK;
    }
  };

  // The service catches its own failures; this is the last line so a message never errors the invocation.
  async function guarded(run: () => Promise<void>, connectionId: string): Promise<void> {
    try {
      await run();
    } catch (err) {
      log.error(
        { connectionId, err: err instanceof Error ? err.message : String(err) },
        'ws handler failed',
      );
    }
  }
}
