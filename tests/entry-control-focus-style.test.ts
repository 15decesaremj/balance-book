import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balanceBookDarkTheme, balanceBookLightTheme } from '../apps/desktop/src/renderer/theme';

describe('entry control focus styling', () => {
  it('uses one rounded blue border for focused Fluent entry controls', () => {
    const styles = readFileSync(
      new URL('../apps/desktop/src/renderer/styles.css', import.meta.url),
      'utf8',
    );

    expect(styles).toContain('--balance-focus-ring: #5b9dff');
    expect(styles).toContain('outline: 2px solid var(--balance-focus-ring)');
    expect(styles).toContain(':where(.fui-Input, .fui-Select, .fui-Textarea):focus-within');
    expect(styles).toContain('border-color: var(--balance-focus-ring) !important');
    expect(styles).toContain(':where(.fui-Input, .fui-Select, .fui-Textarea):focus-within::after');
    expect(styles).toContain('display: none !important');
    expect(styles).not.toContain('0 0 0 2px var(--balance-focus-ring)');
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

  it('uses theme-aware liquid-glass surfaces and one deliberate layout gap', () => {
    const app = readFileSync(
      new URL('../apps/desktop/src/renderer/App.tsx', import.meta.url),
      'utf8',
    );
    const dashboard = readFileSync(
      new URL('../apps/desktop/src/renderer/DashboardPage.tsx', import.meta.url),
      'utf8',
    );
    const styles = readFileSync(
      new URL('../apps/desktop/src/renderer/styles.css', import.meta.url),
      'utf8',
    );

    expect(app).toContain("backgroundColor: 'color-mix(in srgb, var(--balance-glass)");
    expect(app).toContain("borderRight: '1px solid var(--balance-glass-border)'");
    expect(app).not.toContain("backgroundColor: 'rgba(9, 17, 28, 0.7)'");
    expect(dashboard).toContain("backgroundColor: 'var(--balance-glass-strong)'");
    expect(dashboard).toContain("backgroundColor: 'var(--balance-glass)'");
    expect(dashboard).not.toContain("backgroundColor: 'rgba(17, 27, 40, 0.72)'");
    expect(styles).not.toContain('details + details');
    expect(styles).not.toContain('.fui-Card + details');
  });

  it('announces true aggregate utilization even when the visual bar is capped at 100%', () => {
    const corePages = readFileSync(
      new URL('../apps/desktop/src/renderer/CorePages.tsx', import.meta.url),
      'utf8',
    );

    expect(corePages).toContain(
      'aria-valuetext={`${totalUtilizationPercent.toFixed(1)}% utilization`}',
    );
    expect(corePages).toContain('className={styles.inactiveLoanDisclosure}');
    expect(corePages).toContain('if (effectiveMetrics.active) return loanCard;');
  });
});
