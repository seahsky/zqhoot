import { describe, expect, it, vi } from 'vitest';
import { RuntimeConfig } from '@zqhoot/protocol';
import {
  ConfigError,
  devFallbackConfig,
  getRuntimeConfig,
  loadRuntimeConfig,
  setRuntimeConfig,
} from '../src/config/runtime.ts';

const location = { protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173' };

const valid: RuntimeConfig = {
  target: 'aws',
  apiBaseUrl: '',
  wsUrl: 'wss://abc.execute-api.us-east-1.amazonaws.com/prod',
  mediaBaseUrl: 'https://quiz.example/',
  joinUrl: 'https://quiz.example/join',
  auth: {
    mode: 'cognito',
    region: 'us-east-1',
    userPoolId: 'us-east-1_abc',
    clientId: 'client',
    domain: 'https://zq.auth.us-east-1.amazoncognito.com',
  },
};

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('loadRuntimeConfig', () => {
  it('fetches /config.json and validates it with the protocol schema', async () => {
    const fetchImpl = vi.fn(reply(valid));
    const config = await loadRuntimeConfig({ fetchImpl, isDev: false, location });
    expect(config).toEqual(valid);
    expect(fetchImpl.mock.calls[0]![0]).toBe('/config.json');
  });

  it('throws in production when the config is missing, invalid, or unreachable', async () => {
    for (const fetchImpl of [
      reply({ error: 'x' }, 404),
      reply({ target: 'moon' }),
      reply('<html>', 200),
      (async () => {
        throw new TypeError('offline');
      }) as typeof fetch,
    ]) {
      await expect(loadRuntimeConfig({ fetchImpl, isDev: false, location })).rejects.toBeInstanceOf(
        ConfigError,
      );
    }
  });

  it('falls back to same-origin defaults under `vite dev` when there is no server', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const config = await loadRuntimeConfig({ fetchImpl: reply({}, 404), isDev: true, location });
    expect(config).toEqual(devFallbackConfig(location));
    expect(RuntimeConfig.safeParse(config).success).toBe(true);
    expect(config.wsUrl).toBe('ws://localhost:5173/ws');
    expect(config.apiBaseUrl).toBe('');
    vi.restoreAllMocks();
  });

  it('uses wss when the dev page is served over https', () => {
    const config = devFallbackConfig({
      protocol: 'https:',
      host: 'dev.example',
      origin: 'https://dev.example',
    });
    expect(config.wsUrl).toBe('wss://dev.example/ws');
  });

  it('prefers a real config over the fallback even in dev', async () => {
    const config = await loadRuntimeConfig({ fetchImpl: reply(valid), isDev: true, location });
    expect(config.target).toBe('aws');
  });
});

describe('runtime config holder', () => {
  it('throws until it is set, then returns the same value', () => {
    // Module state: this test file is the only one that touches it.
    expect(() => getRuntimeConfig()).toThrow(ConfigError);
    setRuntimeConfig(valid);
    expect(getRuntimeConfig()).toBe(valid);
  });
});
