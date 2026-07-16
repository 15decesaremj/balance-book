import { describe, expect, it } from 'vitest';
import { productName } from '@balance-book/domain';
import { formatPlainDate } from '../apps/desktop/src/renderer/utils';

describe('project foundation', () => {
  it('keeps configurable product branding outside financial logic', () => {
    expect(productName).toBe('Balance Book');
  });

  it('renders plain financial dates without a time-zone day shift', () => {
    expect(formatPlainDate('2026-07-13', 'en-US')).toBe('Jul 13, 2026');
  });
});
