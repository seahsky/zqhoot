import { useEffect, useRef } from 'react';
import type { FocusEvent, RefObject } from 'react';

/**
 * Where focus goes when the element that had it is removed or disabled: to `<body>`, which for
 * a keyboard or screen-reader user is the top of the page (WCAG 2.4.3). These helpers hand it to
 * the next sensible control, and only when it really was lost, so they never take focus from a
 * person who has already moved on.
 */

export function focusIsLost(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active === document.documentElement) {
    return true;
  }
  // A confirmation dialog that has just closed still holds focus on its button until the
  // browser's next frame, when it moves to <body>. That is lost focus too.
  return typeof active.checkVisibility === 'function' && !active.checkVisibility();
}

/** Focuses `el` if focus has been lost. Returns whether focus is now on it. */
export function rescueFocus(el: HTMLElement | null | undefined): boolean {
  if (!el || !focusIsLost()) return false;
  el.focus();
  return document.activeElement === el;
}

/**
 * For a control that goes away with the state it acts on (Skip question once the question is
 * over, End session once it has ended). Spread the returned handlers on the container: when the
 * control that last held focus inside it has been removed, `fallback` is focused instead.
 */
export function useFocusFallback(
  scope: RefObject<HTMLElement | null>,
  fallback: (scope: HTMLElement) => HTMLElement | null | undefined,
) {
  const last = useRef<HTMLElement | null>(null);
  // Every render: a removed element sends no blur event, so the render is the only signal.
  useEffect(() => {
    const gone = last.current;
    const el = scope.current;
    if (!gone || gone.isConnected || !el) return;
    last.current = null;
    rescueFocus(fallback(el));
  });
  return {
    onFocus: (e: FocusEvent<HTMLElement>) => {
      last.current = e.target;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      const target = e.target;
      // A browser may report the removal itself as a blur. By the next microtask the element is
      // either gone (keep it: that is what this is for) or still there because the person moved
      // on (forget it), and a move inside the container has already set the new element.
      queueMicrotask(() => {
        if (target.isConnected && last.current === target) last.current = null;
      });
    },
  };
}
