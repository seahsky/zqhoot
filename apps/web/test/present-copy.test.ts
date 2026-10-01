import { describe, expect, it } from 'vitest';
import { answeredText, eyebrowText, gainText } from '../src/screens/present/copy.ts';

describe('the presenter wording', () => {
  it('the answer count is "N of M answered", grouped in thousands', () => {
    expect(answeredText(12, 22)).toBe('12 of 22 answered');
    expect(answeredText(377, 400)).toBe('377 of 400 answered');
    expect(answeredText(1234, 12000)).toBe('1,234 of 12,000 answered');
    expect(answeredText(0, 0)).toBe('0 of 0 answered');
  });

  it('the running header counts questions from one, and says "Results" once one is closed', () => {
    expect(eyebrowText(2, 10, false)).toBe('Question 3 of 10');
    expect(eyebrowText(2, 10, true)).toBe('Question 3 of 10 · Results');
  });

  it('points gained always show, "+0" included, and never go negative', () => {
    expect(gainText(940)).toBe('+940');
    expect(gainText(1240)).toBe('+1,240');
    expect(gainText(0)).toBe('+0');
    expect(gainText(-5)).toBe('+0');
  });
});
