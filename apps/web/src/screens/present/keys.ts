/** The presenter's keyboard map (ADR-0016). Pure, so the whole map is unit-tested. */

export type PresenterKeyAction =
  'next' | 'close' | 'fullscreen' | 'text-size' | 'theme' | 'lock' | 'help';

export interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: KeyTarget | null;
}

const TEXT_CONTROLS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** These activate on Space and Enter by themselves; handling the key too would press twice. */
const ACTIVATES_ON_KEY = new Set(['BUTTON', 'A', 'SUMMARY']);

const BY_KEY: Record<string, PresenterKeyAction> = {
  ' ': 'next',
  ArrowRight: 'next',
  PageDown: 'next',
  Enter: 'close',
  f: 'fullscreen',
  t: 'text-size',
  d: 'theme',
  l: 'lock',
  '?': 'help',
};

/**
 * The action for a key press, or null when it is not ours. `ArrowLeft` is deliberately
 * missing: there is no going back mid-game, and a clicker's back button must not do harm.
 * Keys typed into a form control are ignored, and so are shortcuts with Ctrl, Cmd or Alt, so
 * the browser's own (find, reload, zoom) keep working.
 */
export function presenterKeyAction(e: KeyLike, helpOpen = false): PresenterKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const tag = e.target?.tagName?.toUpperCase();
  if (e.target?.isContentEditable || (tag !== undefined && TEXT_CONTROLS.has(tag))) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const action = BY_KEY[key];
  if (action === undefined) return null;
  if (helpOpen) return action === 'help' ? 'help' : null;
  if ((key === ' ' || key === 'Enter') && tag !== undefined && ACTIVATES_ON_KEY.has(tag)) {
    return null;
  }
  return action;
}

export interface Shortcut {
  keys: string[];
  does: string;
}

/** What the help overlay lists; kept next to the map so the two cannot drift apart unnoticed. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    keys: ['Space', '→', 'Page Down'],
    does: 'Next: start, show results, leaderboard, next question',
  },
  { keys: ['Enter'], does: 'End the question now' },
  { keys: ['F'], does: 'Full screen on or off' },
  { keys: ['T'], does: 'Text size: 100%, 125%, 150%' },
  { keys: ['D'], does: 'Light or dark screen' },
  { keys: ['L'], does: 'Lock or unlock joining' },
  { keys: ['?'], does: 'Show or hide this list' },
];
