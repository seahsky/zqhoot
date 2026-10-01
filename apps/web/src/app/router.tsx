import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { NavigationStore, parseRoute } from './routing.ts';
import type { NavigateOptions, NavigationBlocker, Route } from './routing.ts';

export { matchPath, toHref } from './routing.ts';
export type { NavigateOptions, NavigationBlocker, Route, Transition } from './routing.ts';

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
export function navigate(to: string, opts?: NavigateOptions): void {
  getStore().navigate(to, opts);
}

/**
 * While `blocker` is not null, every navigation (links, `navigate()`, Back and Forward) is held
 * back and handed to it, to be carried on with by calling `transition.proceed()`.
 */
export function useNavigationBlocker(blocker: NavigationBlocker | null): void {
  const latest = useRef(blocker);
  latest.current = blocker;
  const active = blocker !== null;
  useEffect(() => {
    if (!active) return;
    return getStore().block((transition) => latest.current?.(transition));
  }, [active]);
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
