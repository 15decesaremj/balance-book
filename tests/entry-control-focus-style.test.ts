import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balanceBookDarkTheme, balanceBookLightTheme } from '../apps/desktop/src/renderer/theme';

describe('entry control focus styling', () => {
  it('uses the blue application focus ring for native and Fluent entry controls', () => {
    const styles = readFileSync(
      new URL('../apps/desktop/src/renderer/styles.css', import.meta.url),
      'utf8',
    );

    expect(styles).toContain('--balance-focus-ring: #5b9dff');
    expect(styles).toContain('outline: 2px solid var(--balance-focus-ring)');
    expect(styles).toContain(':where(.fui-Input, .fui-Select, .fui-Textarea):focus-within');
    expect(styles).toContain('0 0 0 2px var(--balance-focus-ring)');
  });

  it('keeps Fluent buttons, checkboxes, and other controls on the same blue focus language', () => {
    expect(balanceBookDarkTheme).toMatchObject({
      colorStrokeFocus1: '#5b9dff',
      colorStrokeFocus2: '#5b9dff',
    });
    expect(balanceBookLightTheme).toMatchObject({
      colorStrokeFocus1: '#246fdd',
      colorStrokeFocus2: '#246fdd',
    });
  });
});
