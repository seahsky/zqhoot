import type { Page, WebSocketRoute } from '@playwright/test';

/**
 * A scripted server for the flow specs: `/config.json` and the WebSocket are answered by the
 * test, so the containers run for real (real socket, real storage, real timers) against
 * whatever the test says the server does.
 */

export type Msg = Record<string, unknown> & { type: string };

export interface ConfigOverrides {
  auth?: Record<string, unknown>;
  mediaBaseUrl?: string;
}

export class ScriptedServer {
  readonly sockets: WebSocketRoute[] = [];
  readonly received: Msg[] = [];
  /** Called for every client message; reply with `send`. */
  onClient: (msg: Msg, ws: WebSocketRoute) => void = () => undefined;

  async attach(page: Page, overrides: ConfigOverrides = {}) {
    await page.route('**/config.json', (route) =>
      route.fulfill({
        json: {
          target: 'vm',
          apiBaseUrl: '',
          wsUrl: 'ws://localhost:4173/ws',
          mediaBaseUrl: overrides.mediaBaseUrl ?? '/',
          joinUrl: 'http://localhost:4173/join',
          auth: overrides.auth ?? { mode: 'local' },
        },
      }),
    );
    await page.routeWebSocket('ws://localhost:4173/ws', (ws) => {
      this.sockets.push(ws);
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as Msg;
        this.received.push(msg);
        this.onClient(msg, ws);
      });
    });
  }

  /** Every server message carries the server's clock, stamped as it is sent. */
  send(ws: WebSocketRoute, msg: Record<string, unknown>) {
    ws.send(JSON.stringify({ ts: Date.now(), ...msg }));
  }

  get last(): WebSocketRoute {
    const ws = this.sockets.at(-1);
    if (!ws) throw new Error('no socket yet');
    return ws;
  }

  clientMessages(type: string) {
    return this.received.filter((m) => m.type === type);
  }
}
