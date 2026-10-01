import { describe, expect, it, vi } from 'vitest';
import {
  NavigationStore,
  isInternalPath,
  matchPath,
  normalizePath,
  parseRoute,
  toHref,
} from '../src/app/routing.ts';
import type { Transition } from '../src/app/routing.ts';

describe('parseRoute', () => {
  it('splits path and query', () => {
    const r = parseRoute('/join?pin=123456&x=1');
    expect(r.path).toBe('/join');
    expect(r.query.get('pin')).toBe('123456');
    expect(r.query.get('x')).toBe('1');
    expect(r.query.get('missing')).toBeNull();
  });

  it('normalises trailing and doubled slashes, and ignores the hash', () => {
    expect(parseRoute('/play/?s=abc#top').path).toBe('/play');
    expect(parseRoute('/play/?s=abc#top').query.get('s')).toBe('abc');
    expect(parseRoute('//host//quizzes/').path).toBe('/host/quizzes');
    expect(parseRoute('').path).toBe('/');
    expect(parseRoute('?a=1').path).toBe('/');
  });

  it('decodes query values', () => {
    expect(parseRoute('/join?pin=12%2034').query.get('pin')).toBe('12 34');
  });
});

describe('matchPath', () => {
  it('matches exactly without a wildcard', () => {
    expect(matchPath('/join', '/join')).toBe(true);
    expect(matchPath('/join', '/join/extra')).toBe(false);
    expect(matchPath('/join', '/joined')).toBe(false);
    expect(matchPath('/', '/')).toBe(true);
    expect(matchPath('/', '/join')).toBe(false);
  });

  it('treats a trailing * as the prefix and everything under it', () => {
    expect(matchPath('/host*', '/host')).toBe(true);
    expect(matchPath('/host*', '/host/quizzes')).toBe(true);
    expect(matchPath('/host*', '/host/quizzes/abc/edit')).toBe(true);
    expect(matchPath('/host*', '/hosting')).toBe(false);
    expect(matchPath('/host*', '/')).toBe(false);
  });
});

describe('toHref and normalizePath', () => {
  it('builds hrefs, dropping undefined values and encoding the rest', () => {
    expect(toHref('/play', { s: 'abc' })).toBe('/play?s=abc');
    expect(toHref('/join', { pin: '123456', ref: undefined })).toBe('/join?pin=123456');
    expect(toHref('/join')).toBe('/join');
    expect(toHref('/x', { q: 'a b&c' })).toBe('/x?q=a+b%26c');
  });

  it('normalises paths', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('///')).toBe('/');
    expect(normalizePath('host')).toBe('/host');
  });
});

describe('isInternalPath', () => {
  it('only allows same-origin absolute paths', () => {
    expect(isInternalPath('/play?s=1')).toBe(true);
    expect(isInternalPath('/')).toBe(true);
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'play',
      '',
    ]) {
      expect(isInternalPath(bad)).toBe(false);
    }
  });
});

/**
 * A browser history in miniature: entries with their URLs and states, a position, and `go()`
 * that arrives later as a popstate (as it does in a browser), delivered by `flush()`.
 */
function fakeEnv(initial = '/') {
  const entries: Array<{ url: string; state: unknown }> = [{ url: initial, state: null }];
  let at = 0;
  const queue: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const firePop = () => {
    for (const l of [...listeners]) l();
  };
  const env = {
    pushed: [] as string[],
    replaced: [] as string[],
    listeners,
    get location() {
      const url = entries[at]?.url ?? '/';
      const q = url.indexOf('?');
      return { pathname: q < 0 ? url : url.slice(0, q), search: q < 0 ? '' : url.slice(q) };
    },
    history: {
      get state(): unknown {
        return entries[at]?.state ?? null;
      },
      pushState(state: unknown, _t: string, url?: string | URL | null) {
        env.pushed.push(String(url));
        entries.splice(at + 1);
        entries.push({ url: String(url), state });
        at += 1;
      },
      replaceState(state: unknown, _t: string, url?: string | URL | null) {
        if (url !== undefined) env.replaced.push(String(url));
        entries[at] = { url: url === undefined ? (entries[at]?.url ?? '/') : String(url), state };
      },
      go(delta: number) {
        queue.push(() => {
          at = Math.min(entries.length - 1, Math.max(0, at + delta));
          firePop();
        });
      },
    },
    addEventListener: (_: 'popstate', l: () => void) => listeners.add(l),
    removeEventListener: (_: 'popstate', l: () => void) => listeners.delete(l),
    scrollTo: vi.fn(),
    /** A pop to an entry this store knows nothing about (no state), as the very first page has. */
    pop(to: string) {
      entries[at] = { url: to, state: null };
      firePop();
    },
    /** The person presses Back or Forward. */
    back: () => env.history.go(-1),
    forward: () => env.history.go(1),
    /** Delivers every popstate that is due, including the ones those cause. */
    flush() {
      while (queue.length > 0) queue.shift()?.();
    },
    /** Delivers only the first one that is due. */
    flushOne() {
      queue.shift()?.();
    },
    get url() {
      return env.location.pathname + env.location.search;
    },
    get position() {
      return at;
    },
    get length() {
      return entries.length;
    },
  };
  return env;
}

describe('NavigationStore', () => {
  it('reports pathname + search as its snapshot', () => {
    expect(new NavigationStore(fakeEnv('/join?pin=1')).getSnapshot()).toBe('/join?pin=1');
  });

  it('pushes the entry, scrolls to the top, and notifies subscribers', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    const seen: string[] = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot()));
    store.navigate('/join?pin=123456');
    expect(env.pushed).toEqual(['/join?pin=123456']);
    expect(env.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(seen).toEqual(['/join?pin=123456']);
    off();
  });

  it('replaces instead of pushing, without scrolling', () => {
    const env = fakeEnv('/join');
    const store = new NavigationStore(env);
    store.navigate('/play?s=abc', { replace: true });
    expect(env.replaced).toEqual(['/play?s=abc']);
    expect(env.pushed).toEqual([]);
    expect(env.scrollTo).not.toHaveBeenCalled();
  });

  it('going to the page that is already shown replaces it, so Back does not stall', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    store.navigate('/edit?q=new');
    store.navigate('/edit?q=new');
    expect(env.pushed).toEqual(['/edit?q=new']);
    expect(env.replaced).toEqual(['/edit?q=new']);
    expect(env.length).toBe(2);
  });

  it('follows the back button through popstate', () => {
    const env = fakeEnv('/join');
    const store = new NavigationStore(env);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    env.pop('/');
    expect(seen).toEqual(['/']);
  });

  it('follows Back and Forward through entries it pushed', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.navigate('/host');
    store.navigate('/edit?q=new');
    env.back();
    env.flush();
    env.back();
    env.flush();
    env.forward();
    env.flush();
    expect(seen).toEqual(['/host', '/edit?q=new', '/host', '/', '/host']);
    expect(store.getSnapshot()).toBe('/host');
  });

  it('listens to popstate only while somebody is subscribed', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    expect(env.listeners.size).toBe(0);
    const a = store.subscribe(() => undefined);
    const b = store.subscribe(() => undefined);
    expect(env.listeners.size).toBe(1);
    a();
    expect(env.listeners.size).toBe(1);
    b();
    expect(env.listeners.size).toBe(0);
  });

  it('refuses to navigate away from the site', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    expect(() => store.navigate('https://evil.example')).toThrow();
    expect(() => store.navigate('//evil.example')).toThrow();
    expect(env.pushed).toEqual([]);
  });
});

describe('NavigationStore blockers (unsaved changes)', () => {
  /** A store on `/host`, then `/edit?q=new`, with a blocker that keeps what it is handed. */
  function editing() {
    const env = fakeEnv('/host');
    const store = new NavigationStore(env);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.navigate('/edit?q=new');
    const held: Transition[] = [];
    const unblock = store.block((t) => held.push(t));
    seen.length = 0;
    return { env, store, seen, held, unblock };
  }

  it('holds back a link: nothing moves until proceed() is called', () => {
    const { env, store, seen, held } = editing();
    store.navigate('/host');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ to: '/host', kind: 'push' });
    expect(env.url).toBe('/edit?q=new');
    expect(seen).toEqual([]);
    held[0]?.proceed();
    expect(env.url).toBe('/host');
    expect(seen).toEqual(['/host']);
  });

  it('asks about a link to the very page it is on, so "New quiz" on a new quiz can start over', () => {
    const { store, held, env } = editing();
    store.navigate('/edit?q=new');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ to: '/edit?q=new', kind: 'push' });
    expect(env.length).toBe(2);
  });

  it('a page-made navigation with force skips the blocker', () => {
    const { store, held, env } = editing();
    store.navigate('/edit?q=quiz-1', { replace: true, force: true });
    expect(held).toEqual([]);
    expect(env.url).toBe('/edit?q=quiz-1');
  });

  it('Back is undone: the URL and the page are restored, and the blocker hears about it', () => {
    const { env, store, seen, held } = editing();
    env.back();
    env.flush();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ to: '/host', kind: 'pop' });
    // Restored to the editor, at the position it was, and the page never showed /host.
    expect(env.url).toBe('/edit?q=new');
    expect(env.position).toBe(1);
    expect(store.getSnapshot()).toBe('/edit?q=new');
    expect(seen).toEqual([]);
  });

  it('while Back is being undone, the store keeps reporting the page on screen', () => {
    const { env, store, held } = editing();
    env.back();
    env.flushOne();
    // The browser has moved; the undo has not arrived yet. A render now must still see the editor.
    expect(env.url).toBe('/host');
    expect(held).toHaveLength(1);
    expect(store.getSnapshot()).toBe('/edit?q=new');
    env.flush();
    expect(env.url).toBe('/edit?q=new');
  });

  it('after a cancelled Back, proceed() leaves the way Back would have', () => {
    const { env, store, seen, held, unblock } = editing();
    env.back();
    env.flush();
    held[0]?.proceed();
    env.flush();
    expect(env.url).toBe('/host');
    expect(env.position).toBe(0);
    expect(store.getSnapshot()).toBe('/host');
    expect(seen).toEqual(['/host']);
    // The editor is gone, and so is its blocker. Forward still returns to it: the history was
    // not rewritten.
    unblock();
    env.forward();
    env.flush();
    expect(store.getSnapshot()).toBe('/edit?q=new');
  });

  it('a cancelled Back can be repeated, and the history stays one entry per page', () => {
    const { env, held } = editing();
    for (let i = 0; i < 3; i++) {
      env.back();
      env.flush();
      expect(env.url).toBe('/edit?q=new');
    }
    expect(held).toHaveLength(3);
    expect(env.length).toBe(2);
  });

  it('Forward is held back too, and undone', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    store.subscribe(() => undefined);
    store.navigate('/edit?q=new');
    store.navigate('/host');
    env.back();
    env.flush();
    const held: Transition[] = [];
    store.block((t) => held.push(t));
    env.forward();
    env.flush();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ to: '/host', kind: 'pop' });
    expect(env.url).toBe('/edit?q=new');
    held[0]?.proceed();
    env.flush();
    expect(store.getSnapshot()).toBe('/host');
  });

  it('a jump of several entries is undone by the same distance', () => {
    const env = fakeEnv('/');
    const store = new NavigationStore(env);
    store.subscribe(() => undefined);
    store.navigate('/host');
    store.navigate('/edit?q=a');
    store.navigate('/edit?q=new');
    const held: Transition[] = [];
    store.block((t) => held.push(t));
    env.history.go(-3);
    env.flush();
    expect(held[0]).toMatchObject({ to: '/', kind: 'pop' });
    expect(env.url).toBe('/edit?q=new');
    expect(env.position).toBe(3);
    held[0]?.proceed();
    env.flush();
    expect(store.getSnapshot()).toBe('/');
    expect(env.position).toBe(0);
  });

  it('a pop to an entry it never pushed is undone by putting the page back on top', () => {
    const env = fakeEnv('/host');
    const store = new NavigationStore(env);
    store.subscribe(() => undefined);
    const held: Transition[] = [];
    store.block((t) => held.push(t));
    env.pop('/somewhere');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ to: '/somewhere', kind: 'pop' });
    expect(env.url).toBe('/host');
    held[0]?.proceed();
    expect(store.getSnapshot()).toBe('/somewhere');
  });

  it('a pop that lands on the same URL (a fragment entry) is not a departure', () => {
    const { env, store, held, seen } = editing();
    env.pop('/edit?q=new');
    expect(held).toEqual([]);
    expect(store.getSnapshot()).toBe('/edit?q=new');
    expect(seen).toEqual(['/edit?q=new']);
  });

  it('once the blocker is removed, everything goes through again', () => {
    const { env, store, held, unblock } = editing();
    unblock();
    store.navigate('/host');
    expect(held).toEqual([]);
    expect(env.url).toBe('/host');
    env.back();
    env.flush();
    expect(store.getSnapshot()).toBe('/edit?q=new');
  });

  it('the newest blocker wins, and removing an old one does not remove it', () => {
    const { store, held, unblock } = editing();
    const second: Transition[] = [];
    const unblockSecond = store.block((t) => second.push(t));
    unblock();
    store.navigate('/host');
    expect(held).toEqual([]);
    expect(second).toHaveLength(1);
    unblockSecond();
  });
});
