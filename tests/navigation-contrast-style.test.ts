import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const relativeLuminance = (hex: string): number => {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color: ${hex}`);

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};

const contrastRatio = (foreground: string, background: string): number => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
};

describe('sidebar navigation contrast', () => {
  it('keeps light-theme navigation contrast-safe even against solid white glass', () => {
    expect(contrastRatio('#445268', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', '#0f5fca')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', '#154ca7')).toBeGreaterThanOrEqual(4.5);
  });

  it('uses the verified tokens without animating through low-contrast text colors', () => {
    const app = readFileSync(
      new URL('../apps/desktop/src/renderer/App.tsx', import.meta.url),
      'utf8',
    );
    const styles = readFileSync(
      new URL('../apps/desktop/src/renderer/styles.css', import.meta.url),
      'utf8',
    );

    expect(styles).toContain('--balance-nav-foreground: #445268');
    expect(styles).toContain('--balance-nav-active-foreground: #ffffff');
    expect(styles).toContain('--balance-nav-active-background: #0f5fca');
    expect(styles).toContain("html[data-theme='light'] .balance-nav-button");
    expect(styles).toContain(".balance-nav-button[aria-current='page']");
    expect(styles).toContain('transition-property: transform, box-shadow !important');
    expect(app).toContain("transitionProperty: 'transform, box-shadow'");
    expect(app).toContain('\'&[aria-current="page"]\'');
    expect(app).toContain('balance-nav-button');
    expect(app).not.toContain("transitionProperty: 'background-color, color");
  });
});
