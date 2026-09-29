import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A choice kept in `localStorage` (text size, stage theme). Every access is wrapped: storage
 * can throw in a private window or with site data blocked, and the page must work without it.
 */
export function readChoice<T extends string | number>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return allowed.find((v) => String(v) === raw) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeChoice(key: string, value: string | number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // The choice then lasts only until the page is reloaded.
  }
}

export function usePersistentChoice<T extends string | number>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readChoice(key, allowed, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeChoice(key, next);
    },
    [key],
  );
  return [value, set];
}

/**
 * At most one update per `ms`: the value shown now, and the latest one a moment later. Used
 * for the `role="status"` chart summaries, which must not chatter (WCAG 4.1.3, ADR-0016), and
 * for who has joined the lobby. The first value, at mount, is not an update: the first change
 * after it is shown at once.
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const onScreen = useRef(value);
  const lastAt = useRef(0);

  useEffect(() => {
    // Nothing new to say (a value that came back before its turn): nothing to space out.
    if (Object.is(value, onScreen.current)) return;
    const show = () => {
      lastAt.current = Date.now();
      onScreen.current = value;
      setShown(value);
    };
    const since = Date.now() - lastAt.current;
    if (since >= ms) {
      show();
      return;
    }
    const timer = setTimeout(show, ms - since);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return shown;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matches('(prefers-reduced-motion: reduce)'));
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useFullscreen(): { active: boolean; toggle: () => void } {
  const [active, setActive] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = useCallback(() => {
    // Refused without a user gesture, and absent on some browsers: nothing to report either way.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);
  return { active, toggle };
}

/** The stage theme: an explicit choice pins `data-theme` on the page, otherwise the OS decides. */
export type StageTheme = 'system' | 'light' | 'dark';

export const STAGE_THEMES: readonly StageTheme[] = ['system', 'light', 'dark'];

export function useStageTheme(): { dark: boolean; toggle: () => void } {
  const [theme, setTheme] = usePersistentChoice<StageTheme>(
    'zqhoot:present:theme',
    STAGE_THEMES,
    'system',
  );
  const [systemDark, setSystemDark] = useState(() => matches('(prefers-color-scheme: dark)'));
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);

  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  return { dark, toggle: () => setTheme(dark ? 'light' : 'dark') };
}
