import { InvokeCommand } from '@aws-sdk/client-lambda';
import type { Warmer } from '@zqhoot/service';

/** The one method of `LambdaClient` used here, so tests can stub it. */
export interface InvokeClient {
  send(command: InvokeCommand): Promise<unknown>;
}

const PAYLOAD = new TextEncoder().encode(JSON.stringify({ warmup: true }));

/**
 * ADR-0010: fires `concurrency` async invocations of the ws function when a lobby opens. The
 * calls are issued together because the ws handler holds each one for 200 ms, which is what
 * spreads them across separate execution environments.
 */
export class LambdaWarmer implements Warmer {
  readonly #client: InvokeClient;
  readonly #functionName: string;
  readonly #concurrency: number;

  constructor(client: InvokeClient, functionName: string, concurrency: number) {
    this.#client = client;
    this.#functionName = functionName;
    this.#concurrency = concurrency;
  }

  async warm(): Promise<void> {
    const calls = Array.from({ length: this.#concurrency }, () =>
      this.#client.send(
        new InvokeCommand({
          FunctionName: this.#functionName,
          InvocationType: 'Event',
          Payload: PAYLOAD,
        }),
      ),
    );
    // Every call is awaited even when one fails, or the runtime would freeze it mid-flight.
    const results = await Promise.allSettled(calls);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const first = failed[0];
    if (first !== undefined) {
      const reason: unknown = first.reason;
      throw new Error(
        `${failed.length} of ${this.#concurrency} warm-up invocations failed: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
        { cause: reason },
      );
    }
  }
}
