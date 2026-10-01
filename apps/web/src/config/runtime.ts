import { RuntimeConfig } from '@zqhoot/protocol';

export interface LoadConfigOptions {
  fetchImpl?: typeof fetch;
  /** `import.meta.env.DEV`: only then may a missing config fall back to local defaults. */
  isDev: boolean;
  /** `window.location`-like, for the dev fallback. */
  location: Pick<Location, 'protocol' | 'host' | 'origin'>;
}

/**
 * What `vite dev` uses when no server provides `/config.json`. It points at the same
 * origin: vite.config.ts proxies `/api` and `/ws` to the local server.
 */
export function devFallbackConfig(location: LoadConfigOptions['location']): RuntimeConfig {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    target: 'vm',
    apiBaseUrl: '',
    wsUrl: `${wsProtocol}//${location.host}/ws`,
    mediaBaseUrl: '/',
    joinUrl: `${location.origin}/join`,
    auth: { mode: 'local' },
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Fetches and validates `/config.json` (ADR-0013: public values only). */
export async function loadRuntimeConfig(opts: LoadConfigOptions): Promise<RuntimeConfig> {
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  let failure: string;
  try {
    const res = await doFetch('/config.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      failure = `/config.json returned status ${res.status}`;
    } else {
      const parsed = RuntimeConfig.safeParse(await res.json());
      if (parsed.success) return parsed.data;
      failure = `/config.json is not a valid runtime config: ${parsed.error.message}`;
    }
  } catch (err) {
    failure = `/config.json could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (opts.isDev) {
    console.info(`zqhoot: ${failure}; using development defaults.`);
    return devFallbackConfig(opts.location);
  }
  throw new ConfigError(failure);
}

let current: RuntimeConfig | null = null;

export function setRuntimeConfig(config: RuntimeConfig): void {
  current = config;
}

/** The config loaded at startup. Screens that need it are never mounted before it is set. */
export function getRuntimeConfig(): RuntimeConfig {
  if (!current) throw new ConfigError('Runtime config has not been loaded yet.');
  return current;
}
