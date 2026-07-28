import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type PatchedBraceExpansion = {
  (pattern: string): string[];
  expand: (pattern: string) => string[];
  EXPANSION_MAX_LENGTH: number;
};

describe('patched production dependency compatibility', () => {
  it('keeps patched brace expansion callable by legacy minimatch consumers', () => {
    const braceExpansion = require('brace-expansion') as PatchedBraceExpansion;
    const minimatch = require('minimatch') as {
      (value: string, pattern: string): boolean;
      makeRe: (pattern: string) => RegExp | false;
    };

    expect(braceExpansion('report-{current,prior}.xlsx')).toEqual([
      'report-current.xlsx',
      'report-prior.xlsx',
    ]);
    expect(braceExpansion.expand('card-{one,two}')).toEqual(['card-one', 'card-two']);
    expect(braceExpansion.EXPANSION_MAX_LENGTH).toBe(4_000_000);
    expect(minimatch('statement.xlsx', '*.xlsx')).toBe(true);
    const cardPattern = minimatch.makeRe('card-{one,two}');
    expect(cardPattern).not.toBe(false);
    expect(cardPattern && cardPattern.test('card-two')).toBe(true);
  });
});
