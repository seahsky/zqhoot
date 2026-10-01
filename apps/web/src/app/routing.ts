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
  history: Pick<History, 'pushState' | 'replaceState' | 'go' | 'state'>;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
  scrollTo?(x: number, y: number): void;
}

/**
 * A navigation that a blocker stopped: where it was going, and how to carry on with it once the
 * person has agreed. `proceed` is for one use.
 */
export interface Transition {
  to: string;
  /** `pop` is the browser's Back or Forward button (or a mouse button, Alt+Left, a swipe). */
  kind: 'push' | 'replace' | 'pop';
  proceed: () => void;
}

/**
 * Asked before every navigation while it is registered. It gets the stopped transition and
 * decides when (or whether) to call `proceed`; the navigation itself has not happened.
 */
export type NavigationBlocker = (transition: Transition) => void;

export interface NavigateOptions {
  replace?: boolean;
  /** Skip the blocker: for a navigation the page makes itself, such as after a save. */
  force?: boolean;
}

/** `history.state` slot for the position of an entry among the ones this page has pushed. */
const INDEX_KEY = 'zqIndex';

function indexOf(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>)[INDEX_KEY];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

const urlOf = (l: Pick<Location, 'pathname' | 'search'>) => l.pathname + l.search;

/** `pathname + search` of an internal path, as `location` will report it after a push. */
function urlOfPath(to: string): string {
  const route = parseRoute(to);
  const search = route.query.toString();
  return search === '' ? route.path : `${route.path}?${search}`;
}

/**
 * The single source of truth for "where are we", shaped for `useSyncExternalStore`.
 * `pushState` fires no event, so `navigate` notifies subscribers itself.
 *
 * A blocker (unsaved changes) sees every navigation first: a link, `navigate()`, and the Back and
 * Forward buttons. Those two cannot be cancelled, only undone: the browser has already moved,
 * so each entry this store pushes carries its position, and a blocked pop walks the same
 * distance the other way. Until the blocker lets it through, the store keeps reporting the page
 * that was on screen, so nothing re-renders into the popped route in between.
 */
export class NavigationStore {
  private readonly listeners = new Set<() => void>();
  private current: string;
  /** Position of `current` among this page's history entries; 0 until something is pushed. */
  private index: number;
  private blocker: NavigationBlocker | null = null;
  /** A `go()` that undoes a blocked pop is on its way; its popstate is ours, not the person's. */
  private undoing = false;
  /** A `go()` that a blocker allowed is on its way. */
  private allowed = false;

  constructor(private readonly env: NavigationEnv) {
    this.current = urlOf(env.location);
    this.index = indexOf(env.history.state) ?? 0;
  }

  getSnapshot = (): string => this.current;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.env.addEventListener('popstate', this.onPop);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.env.removeEventListener('popstate', this.onPop);
    };
  };

  /** Registers the blocker (one at a time; the latest wins) and returns how to remove it. */
  block = (blocker: NavigationBlocker): (() => void) => {
    this.blocker = blocker;
    return () => {
      if (this.blocker === blocker) this.blocker = null;
    };
  };

  navigate = (to: string, opts: NavigateOptions = {}): void => {
    if (!isInternalPath(to)) throw new Error(`Refusing to navigate to a non-local path: ${to}`);
    const replace = opts.replace ?? false;
    const blocker = opts.force ? null : this.blocker;
    if (blocker) {
      blocker({
        to,
        kind: replace ? 'replace' : 'push',
        proceed: () => this.commit(to, replace),
      });
      return;
    }
    this.commit(to, replace);
  };

  private commit(to: string, replace: boolean): void {
    const { history } = this.env;
    // Going to the page that is already shown replaces it: a second entry for one URL only
    // makes Back look as if it did nothing.
    if (replace || urlOfPath(to) === this.current) {
      history.replaceState({ [INDEX_KEY]: this.index }, '', to);
    } else {
      // The entry the page loaded with has no position yet; without one, Back to it could not
      // be told from a step to some page this store knows nothing about.
      if (indexOf(history.state) === null) history.replaceState({ [INDEX_KEY]: this.index }, '');
      this.index += 1;
      history.pushState({ [INDEX_KEY]: this.index }, '', to);
    }
    if (!replace) this.env.scrollTo?.(0, 0);
    this.current = urlOf(this.env.location);
    this.emit();
  }

  private readonly onPop = (): void => {
    const reached = indexOf(this.env.history.state);
    if (this.undoing) {
      this.undoing = false;
      return;
    }
    const to = urlOf(this.env.location);
    const blocker = this.blocker;
    if (this.allowed || !blocker || to === this.current) {
      this.allowed = false;
      this.settle(reached);
      return;
    }
    const { history } = this.env;
    if (reached === null || reached === this.index) {
      // No position to walk back to (an entry this store did not push): put the page on top.
      this.index += 1;
      history.pushState({ [INDEX_KEY]: this.index }, '', this.current);
      blocker({ to, kind: 'pop', proceed: () => this.commit(to, false) });
      return;
    }
    const distance = reached - this.index;
    this.undoing = true;
    history.go(-distance);
    blocker({
      to,
      kind: 'pop',
      proceed: () => {
        this.allowed = true;
        history.go(distance);
      },
    });
  };

  private settle(reached: number | null): void {
    if (reached !== null) this.index = reached;
    this.current = urlOf(this.env.location);
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
