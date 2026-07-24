import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const toolSource = (name: string): string =>
  readFileSync(new URL(`../tools/${name}`, import.meta.url), 'utf8');

describe('Windows release metadata', () => {
  it('strips PowerShell file-provider properties from serialized RELEASES evidence', () => {
    const builder = toolSource('build-windows-release.ps1');
    expect(builder).toMatch(/\$actualReleaseLine\s*=\s*\[string\]\s*\(Get-Content/);
    expect(builder).toContain('releasesLine = $actualReleaseLine');
    const assembler = toolSource('assemble-public-release.ps1');
    expect(assembler).toMatch(/\$actualReleaseLine\s*=\s*\[string\]\s*\(Get-Content/);
    expect(assembler).toContain('sourceReleasesLine = $actualReleaseLine');
    expect(assembler).toContain('publicReleasesLine = $publicReleasesLine');

    for (const script of ['build-squirrel-offline.ps1', 'validate-windows-release.ps1']) {
      expect(toolSource(script)).toMatch(/\$releaseLine\s*=\s*\[string\]\s*\(Get-Content/);
    }
  });

  it('derives major-version release labels instead of rejecting 2.0.0', () => {
    const builder = toolSource('build-windows-release.ps1');
    const validator = toolSource('validate-windows-release.ps1');
    const assembler = toolSource('assemble-public-release.ps1');

    expect(builder).toContain("$releaseLabel = 'V' + $Version.Split('.')[0]");
    expect(validator).toContain("$releaseLabel = 'V' + $ExpectedVersion.Split('.')[0]");
    expect(builder).not.toContain('^1\\.\\d+\\.\\d+$');
    expect(assembler).not.toContain('^1\\.\\d+\\.\\d+$');
    expect(builder).toContain('Install Balance Book $releaseLabel ($Version)');
    expect(validator).toContain('Install Balance Book $releaseLabel ($ExpectedVersion)');
  });

  it('runs native SQLite tests through the same isolated process pool as the package script', () => {
    const verify = toolSource('verify.mjs');
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: { test: string } };

    expect(verify).toContain("'--pool=forks'");
    expect(verify).not.toContain("'--pool=threads'");
    expect(verify).toContain("'--maxWorkers=1'");
    expect(packageJson.scripts.test).toContain('--pool=forks --maxWorkers=1');
  });

  it('binds the signed packaged executable into the update package before release assembly', () => {
    const squirrel = toolSource('build-squirrel-offline.ps1');
    const assembler = toolSource('assemble-public-release.ps1');
    const appSign = squirrel.indexOf('& $signTool sign', squirrel.indexOf('$signingConfigured'));
    const packageCopy = squirrel.indexOf(
      'Copy-Item -LiteralPath $AppDirectory -Destination $stagedApp -Recurse',
    );

    expect(appSign).toBeGreaterThan(0);
    expect(appSign).toBeLessThan(packageCopy);
    expect(squirrel).not.toContain('--signWithParams');
    expect(assembler).toContain('$publicPackageUrl');
    expect(assembler).toContain('immutableAssetUrl = $publicPackageUrl');
    for (const asset of [
      '$setupName',
      '$uninstallerName',
      '$packageName',
      "'LICENSE.txt'",
      "'README-FIRST.txt'",
      "'RELEASES'",
      "'RELEASE-METADATA.json'",
      "'SHA256SUMS.txt'",
      "'THIRD_PARTY_NOTICES.txt'",
    ]) {
      expect(assembler).toContain(asset);
    }
  });

  it('pins public release actions and keeps rollback feed-only', () => {
    const release = readFileSync(
      new URL('../.github/workflows/release-beta.yml', import.meta.url),
      'utf8',
    );
    const rollback = readFileSync(
      new URL('../.github/workflows/rollback-beta-feed.yml', import.meta.url),
      'utf8',
    );
    const uses = [...`${release}\n${rollback}`.matchAll(/uses:\s*([^\s#]+)/g)].map(
      (match) => match[1],
    );

    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(release).toContain("BALANCE_BOOK_UPDATES_ENABLED: '1'");
    expect(release).toContain('environment: public-release');
    expect(release).toContain('attest-build-provenance@');
    expect(release).toContain('Published beta is not an immutable prerelease.');
    expect(rollback).not.toMatch(/gh release (?:create|edit|delete)/u);
    expect(rollback).toContain('Deploy last known-good feed');
  });
});
