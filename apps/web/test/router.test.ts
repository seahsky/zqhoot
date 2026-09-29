import { describe, expect, it, vi } from 'vitest';
import {
  NavigationStore,
  isInternalPath,
  matchPath,
  normalizePath,
  parseRoute,
  toHref,
} from '../src/app/routing.ts';
import type { NavigationEnv } from '../src/app/routing.ts';

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

function fakeEnv(initial = '/'): NavigationEnv & {
  pushed: string[];
  replaced: string[];
  pop(to: string): void;
  listeners: Set<() => void>;
} {
  const [path = '/', search = ''] = initial.split(/(?=\?)/);
  const listeners = new Set<() => void>();
  const env = {
    location: { pathname: path, search },
    pushed: [] as string[],
    replaced: [] as string[],
    listeners,
    history: {
      pushState(_s: unknown, _t: string, url?: string | URL | null) {
        env.pushed.push(String(url));
        apply(String(url));
      },
      replaceState(_s: unknown, _t: string, url?: string | URL | null) {
        env.replaced.push(String(url));
        apply(String(url));
      },
    },
    addEventListener: (_: 'popstate', l: () => void) => listeners.add(l),
    removeEventListener: (_: 'popstate', l: () => void) => listeners.delete(l),
    scrollTo: vi.fn(),
    pop(to: string) {
      apply(to);
      for (const l of [...listeners]) l();
    },
  };
  function apply(url: string) {
    const q = url.indexOf('?');
    env.location = { pathname: q < 0 ? url : url.slice(0, q), search: q < 0 ? '' : url.slice(q) };
  }
  return env;
}

describe('NavigationStore', () => {
  it('reports pathname + search as its snapshot', () => {
    expect(new NavigationStore(fakeEnv('/join?pin=1')).getSnapshot()).toBe('/join?pin=1');
  });

  it('pushes history, scrolls to the top, and notifies subscribers', () => {
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

  it('follows the back button through popstate', () => {
    const env = fakeEnv('/join');
    const store = new NavigationStore(env);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    env.pop('/');
    expect(seen).toEqual(['/']);
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
