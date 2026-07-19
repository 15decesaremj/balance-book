import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const toolSource = (name: string): string =>
  readFileSync(new URL(`../tools/${name}`, import.meta.url), 'utf8');

describe('Windows release metadata', () => {
  it('strips PowerShell file-provider properties from serialized RELEASES evidence', () => {
    for (const script of ['build-windows-release.ps1', 'assemble-public-release.ps1']) {
      const source = toolSource(script);
      expect(source).toMatch(/\$actualReleaseLine\s*=\s*\[string\]\s*\(Get-Content/);
      expect(source).toContain('releasesLine = $actualReleaseLine');
    }

    for (const script of ['build-squirrel-offline.ps1', 'validate-windows-release.ps1']) {
      expect(toolSource(script)).toMatch(/\$releaseLine\s*=\s*\[string\]\s*\(Get-Content/);
    }
  });
});
