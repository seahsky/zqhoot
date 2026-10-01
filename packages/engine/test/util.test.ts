import { describe, expect, it } from 'vitest';
import { jsonBytes } from '../src/util.ts';

describe('jsonBytes', () => {
  it.each([
    ['ascii', 'hello'],
    ['two-byte characters', '\u00e9\u00fc\u0416'],
    ['three-byte characters', '\u20ac\u4e2d\u6587'],
    ['four-byte characters', '\u{1F600}\u{1F1E6}\u{1F1E7}'],
    ['a mix, escaped quotes and newlines', 'a\u00e9\u4e2d\u{1F600}"\n\\'],
    ['a lone surrogate, which JSON escapes', 'a\ud800b'],
    ['nested values', { a: ['\u{1F600}', 1, null, true], b: { c: '\u00e9' } }],
  ])('matches the UTF-8 length of the serialised %s', (_name, value) => {
    expect(jsonBytes(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  });
});
