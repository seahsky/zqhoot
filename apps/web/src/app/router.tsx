import { useMemo, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { NavigationStore, parseRoute } from './routing.ts';
import type { Route } from './routing.ts';

export { matchPath, toHref } from './routing.ts';
export type { Route } from './routing.ts';

let store: NavigationStore | null = null;

// Created on first use so importing this module never touches `window`.
function getStore(): NavigationStore {
  store ??= new NavigationStore(window);
  return store;
}

const serverSnapshot = () => '/';

export function useRoute(): Route {
  const s = getStore();
  const url = useSyncExternalStore(s.subscribe, s.getSnapshot, serverSnapshot);
  return useMemo(() => parseRoute(url), [url]);
}

/** `to` must be a same-origin absolute path such as `/play?s=abc`. */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  getStore().navigate(to, opts);
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
}

/** A real anchor, so open-in-new-tab and copy-link work; plain clicks navigate without a reload. */
export function Link({ to, replace, onClick, target, children, ...rest }: LinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    if (e.defaultPrevented || e.button !== 0 || modified || (target && target !== '_self')) return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return (
    <a {...rest} href={to} target={target} onClick={handleClick}>
      {children}
    </a>
  );
}
