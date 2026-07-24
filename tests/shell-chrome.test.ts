import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { searchSettings } from '../apps/desktop/src/renderer/settings-search';

describe('desktop shell chrome', () => {
  it('makes the compact navigation preference discoverable in Settings search', () => {
    expect(searchSettings('collapse sidebar').map((entry) => entry.id)).toContain('appearance');
    expect(searchSettings('navigation menu').map((entry) => entry.id)).toContain('appearance');
    expect(searchSettings('promotional APR').map((entry) => entry.id)).toContain('card-interest');
  });

  it('keeps the native menu hidden by default and exposes only a validated visibility bridge', () => {
    const main = readFileSync(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
    const preload = readFileSync(
      new URL('../apps/desktop/src/preload.ts', import.meta.url),
      'utf8',
    );
    const renderer = readFileSync(
      new URL('../apps/desktop/src/renderer/App.tsx', import.meta.url),
      'utf8',
    );

    expect(main).toContain('autoHideMenuBar: true');
    expect(main).toContain('mainWindow.setMenuBarVisibility(false)');
    expect(preload).toContain("'shell:set-menu-bar-visibility'");
    expect(renderer).toContain('data-testid="native-menu-reveal-edge"');
    expect(renderer).toContain("'Expand navigation'");
    expect(renderer).toContain("'Collapse navigation'");
  });
});
