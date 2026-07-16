import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import forgeConfig from '../forge.config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('production native packaging', () => {
  it('ships the project license and third-party notices beside the packaged application', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toEqual([
      path.resolve('LICENSE'),
      path.resolve('THIRD_PARTY_NOTICES.txt'),
    ]);
  });

  it('stages rebuild inputs before preserving only the Electron SQLite runtime', async () => {
    const buildPath = await mkdtemp(path.join(os.tmpdir(), 'balance-book-forge-native-'));
    temporaryDirectories.push(buildPath);
    const nativePath = path.join(
      buildPath,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );

    expect(await readFile(nativePath).catch(() => undefined)).toBeUndefined();
    const afterCopyHook = forgeConfig.hooks?.packageAfterCopy;
    if (typeof afterCopyHook !== 'function')
      throw new Error('packageAfterCopy hook is unavailable');
    await afterCopyHook(
      forgeConfig as Parameters<typeof afterCopyHook>[0],
      buildPath,
      '43.1.0',
      'win32',
      'x64',
    );
    await expect(
      readFile(path.join(buildPath, 'node_modules', 'better-sqlite3', 'binding.gyp'), 'utf8'),
    ).resolves.toContain("'target_name': 'better_sqlite3'");

    // Represent Forge's Electron-ABI rebuild, which runs between the two application hooks.
    await mkdir(path.dirname(nativePath), { recursive: true });
    await writeFile(nativePath, 'synthetic-electron-abi-binary');

    const afterPruneHook = forgeConfig.hooks?.packageAfterPrune;
    if (typeof afterPruneHook !== 'function')
      throw new Error('packageAfterPrune hook is unavailable');
    await afterPruneHook(
      forgeConfig as Parameters<typeof afterPruneHook>[0],
      buildPath,
      '43.1.0',
      'win32',
      'x64',
    );

    expect(await readFile(nativePath, 'utf8')).toBe('synthetic-electron-abi-binary');
    await expect(
      readFile(path.join(buildPath, 'node_modules', 'better-sqlite3', 'lib', 'index.js'), 'utf8'),
    ).resolves.toContain("require('./database')");
    expect(
      await readFile(path.join(buildPath, 'node_modules', 'better-sqlite3', 'binding.gyp')).catch(
        () => undefined,
      ),
    ).toBeUndefined();
  });
});
