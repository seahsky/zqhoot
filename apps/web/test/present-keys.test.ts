import { describe, expect, it } from 'vitest';
import { SHORTCUTS, presenterKeyAction } from '../src/screens/present/keys.ts';
import type { KeyLike } from '../src/screens/present/keys.ts';

const press = (key: string, over: Partial<KeyLike> = {}, helpOpen = false) =>
  presenterKeyAction({ key, ...over }, helpOpen);

describe('the presenter keyboard map (ADR-0016)', () => {
  it('Space, right arrow and Page Down are next', () => {
    for (const key of [' ', 'ArrowRight', 'PageDown']) expect(press(key), key).toBe('next');
  });

  it('Enter ends the question', () => {
    expect(press('Enter')).toBe('close');
  });

  it('F, T, D, L and ? are fullscreen, text size, theme, lock and help, in either case', () => {
    expect(press('f')).toBe('fullscreen');
    expect(press('F')).toBe('fullscreen');
    expect(press('t')).toBe('text-size');
    expect(press('d')).toBe('theme');
    expect(press('D')).toBe('theme');
    expect(press('l')).toBe('lock');
    expect(press('?')).toBe('help');
  });

  it('the left arrow does nothing, and neither do keys it does not know', () => {
    for (const key of [
      'ArrowLeft',
      'PageUp',
      'Backspace',
      'Escape',
      'a',
      'x',
      '1',
      'Tab',
      'Shift',
    ]) {
      expect(press(key), key).toBeNull();
    }
  });

  it('leaves the browser its own shortcuts: Ctrl, Cmd and Alt combinations are ignored', () => {
    expect(press('f', { ctrlKey: true })).toBeNull();
    expect(press('l', { metaKey: true })).toBeNull();
    expect(press('d', { altKey: true })).toBeNull();
    expect(press(' ', { ctrlKey: true })).toBeNull();
  });

  it('ignores every key typed into a form control', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      for (const key of [' ', 'Enter', 'l', 'f', 'ArrowRight', 'PageDown', '?']) {
        expect(press(key, { target: { tagName } }), `${tagName} ${key}`).toBeNull();
      }
    }
    expect(press(' ', { target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
  });

  it('does not press twice when a button has focus: Space and Enter belong to the button', () => {
    expect(press(' ', { target: { tagName: 'BUTTON' } })).toBeNull();
    expect(press('Enter', { target: { tagName: 'BUTTON' } })).toBeNull();
    expect(press(' ', { target: { tagName: 'A' } })).toBeNull();
    // A clicker's keys still work after the mouse left focus on a button.
    expect(press('ArrowRight', { target: { tagName: 'BUTTON' } })).toBe('next');
    expect(press('PageDown', { target: { tagName: 'BUTTON' } })).toBe('next');
    expect(press('l', { target: { tagName: 'BUTTON' } })).toBe('lock');
  });

  it('a plain page (body, div) lets every shortcut through', () => {
    expect(press(' ', { target: { tagName: 'BODY' } })).toBe('next');
    expect(press('Enter', { target: { tagName: 'DIV' } })).toBe('close');
    expect(press(' ', { target: null })).toBe('next');
  });

  it('while the help is open only ? answers, so Space cannot advance the game behind it', () => {
    expect(press('?', {}, true)).toBe('help');
    for (const key of [' ', 'Enter', 'ArrowRight', 'PageDown', 'f', 't', 'd', 'l']) {
      expect(press(key, {}, true), key).toBeNull();
    }
  });

  it('every key in the help list is one the map really handles', () => {
    const named: Record<string, string> = {
      Space: ' ',
      '→': 'ArrowRight',
      'Page Down': 'PageDown',
      Enter: 'Enter',
    };
    for (const shortcut of SHORTCUTS) {
      for (const label of shortcut.keys) {
        const key = named[label] ?? label.toLowerCase();
        expect(press(key), label).not.toBeNull();
      }
    }
  });
});
