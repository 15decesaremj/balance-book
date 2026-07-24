import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

describe('Microsoft Store package configuration', () => {
  it('maps the shared three-part application version to an MSIX dot-quad', () => {
    const rootPackage = JSON.parse(read('package.json')) as { version: string };
    const desktopPackage = JSON.parse(read('apps/desktop/package.json')) as { version: string };
    expect(desktopPackage.version).toBe(rootPackage.version);
    expect(rootPackage.version).toMatch(/^[1-9]\d{0,4}\.\d{1,5}\.\d{1,5}$/);
    expect(`${rootPackage.version}.0`).toBe('2.0.8.0');
    for (const segment of rootPackage.version.split('.')) {
      expect(Number(segment)).toBeLessThanOrEqual(65_535);
    }
  });

  it('keeps the desktop manifest narrow and Partner Center-driven', () => {
    const manifest = read('store/Package.appxmanifest.template.xml');
    expect(manifest).toContain('ProcessorArchitecture="x64"');
    expect(manifest).toContain('MinVersion="10.0.17763.0"');
    expect(manifest).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(manifest).toContain('<Resource Language="en-us" />');
    expect(manifest).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(manifest.match(/<(?:rescap:)?Capability\b/gu)).toHaveLength(1);
    expect(manifest).not.toContain('broadFileSystemAccess');
    expect(manifest).not.toContain('unvirtualizedResources');
    for (const token of [
      '{{PACKAGE_NAME}}',
      '{{PUBLISHER}}',
      '{{MSIX_VERSION}}',
      '{{DISPLAY_NAME}}',
      '{{PUBLISHER_DISPLAY_NAME}}',
      '{{DESCRIPTION}}',
      '{{APPLICATION_ID}}',
    ]) {
      expect(manifest).toContain(token);
    }
  });

  it('uses isolated local-test identity and data directories', () => {
    const identity = JSON.parse(read('store/identity.local-test.json')) as {
      packageName: string;
      publisher: string;
      displayName: string;
      productId: string;
    };
    const buildScript = read('tools/build-store-package.ps1');
    expect(identity).toMatchObject({
      packageName: 'BalanceBook.LocalTest',
      publisher: 'CN=Balance Book Local Test',
      displayName: 'Balance Book Store Test',
      productId: '',
    });
    expect(buildScript).toContain("BALANCE_BOOK_STORE_DATA_DIRECTORY = 'Balance Book Store Test'");
    expect(buildScript).toContain(
      "BALANCE_BOOK_LEGACY_DATA_DIRECTORY = 'Balance Book Store Test Legacy'",
    );
    expect(buildScript).toContain("BALANCE_BOOK_UPDATES_ENABLED = '0'");
    expect(buildScript).toContain('workingTreeDirty = $status.Count -gt 0');
  });

  it('keeps Store publication manual, gated, and pinned', () => {
    const workflow = read('.github/workflows/publish-microsoft-store.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+push:/u);
    expect(workflow).toContain(
      "if ('${{ github.ref_name }}' -ne '${{ github.event.repository.default_branch }}')",
    );
    expect(workflow).toContain('run: pnpm verify');
    expect(workflow).toContain(
      'microsoft/microsoft-store-apppublisher@cc9910a8d59f2eb55cbb83df0a3800cf3b5300e0',
    );
    expect(workflow).toContain('version: v0.3.9');
    expect(workflow).toContain('msstore submission get $env:STORE_PRODUCT_ID');
    expect(workflow).toContain("throw 'No existing packaged Store version was found;");
    expect(workflow).toContain('STORE_CLIENT_SECRET: ${{ secrets.STORE_CLIENT_SECRET }}');
    expect(workflow).not.toMatch(/STORE_CLIENT_SECRET:\s+[A-Za-z0-9]/u);
  });
});
