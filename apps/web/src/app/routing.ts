/** Pure routing helpers, kept free of React and `window` so they run under node. */

export interface Route {
  /** Normalised pathname: leading slash, no trailing slash except for the root. */
  path: string;
  query: URLSearchParams;
}

export function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Accepts `pathname + search` (an optional `#hash` is ignored). */
export function parseRoute(url: string): Route {
  const hash = url.indexOf('#');
  const noHash = hash < 0 ? url : url.slice(0, hash);
  const q = noHash.indexOf('?');
  return {
    path: normalizePath(q < 0 ? noHash : noHash.slice(0, q)),
    query: new URLSearchParams(q < 0 ? '' : noHash.slice(q + 1)),
  };
}

/** `/host*` matches `/host` and everything under it; anything else must match exactly. */
export function matchPath(pattern: string, path: string): boolean {
  if (!pattern.endsWith('*')) return normalizePath(pattern) === path;
  const prefix = normalizePath(pattern.slice(0, -1));
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function toHref(path: string, query: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Only same-origin absolute paths are navigable: a `?next=` parameter must never leave the site. */
export function isInternalPath(to: string): boolean {
  return to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\');
}

export interface NavigationEnv {
  location: Pick<Location, 'pathname' | 'search'>;
  history: Pick<History, 'pushState' | 'replaceState'>;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
  scrollTo?(x: number, y: number): void;
}

/**
 * The single source of truth for "where are we", shaped for `useSyncExternalStore`.
 * `pushState` fires no event, so `navigate` notifies subscribers itself.
 */
export class NavigationStore {
  private readonly listeners = new Set<() => void>();
  private readonly onPop = () => this.emit();

  constructor(private readonly env: NavigationEnv) {}

  getSnapshot = (): string => this.env.location.pathname + this.env.location.search;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.env.addEventListener('popstate', this.onPop);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.env.removeEventListener('popstate', this.onPop);
    };
  };

  navigate = (to: string, opts: { replace?: boolean } = {}): void => {
    if (!isInternalPath(to)) throw new Error(`Refusing to navigate to a non-local path: ${to}`);
    if (opts.replace) this.env.history.replaceState(null, '', to);
    else this.env.history.pushState(null, '', to);
    if (!opts.replace) this.env.scrollTo?.(0, 0);
    this.emit();
  };

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
