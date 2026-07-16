import type { ForgeConfig } from '@electron-forge/shared-types';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const electronDownloadCache = process.env.ELECTRON_DOWNLOAD_CACHE;
const electronChecksums = electronDownloadCache
  ? (JSON.parse(
      fsSync.readFileSync(path.resolve('node_modules', 'electron', 'checksums.json'), 'utf8'),
    ) as Record<string, string>)
  : undefined;
const verifiedPrebuiltNative = process.env.BALANCE_BOOK_PREBUILT_NATIVE;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'BalanceBook',
    icon: path.resolve('assets', 'balance-book.ico'),
    extraResource: [path.resolve('LICENSE'), path.resolve('THIRD_PARTY_NOTICES.txt')],
    appCopyright: 'Copyright (c) 2026 Balance Book contributors',
    ...(electronDownloadCache
      ? { download: { cacheRoot: electronDownloadCache, checksums: electronChecksums } }
      : {}),
  },
  rebuildConfig: {
    force: true,
    // A verified Electron-ABI binary is the explicit offline release path. In that mode the prune
    // hook below installs the supplied runtime, so rebuilding the same module would add no safety
    // and would make an otherwise deterministic package depend on local compiler availability.
    onlyModules: verifiedPrebuiltNative ? [] : ['better-sqlite3'],
  },
  makers: [
    new MakerSquirrel({
      // This identity is intentionally stable: changing it would install V1 beside older versions.
      name: 'balance_book_mvp',
      authors: 'Balance Book contributors',
      description: 'Local-first financial operations desktop application for Windows',
      setupIcon: path.resolve('assets', 'balance-book.ico'),
      ...(process.env.WINDOWS_CERTIFICATE_FILE
        ? {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
          }
        : {}),
    }),
    new MakerZIP({}, ['win32']),
  ],
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // Vite intentionally excludes source node_modules contents from the initial copy. Stage the
      // native module's build inputs here so Forge's immediately following Electron rebuild has a
      // real binding.gyp and sources to compile against the target Electron ABI.
      process.stdout.write(`[package] staging SQLite rebuild source in ${buildPath}\n`);
      const rebuildFiles = [
        ['better-sqlite3', 'package.json'],
        ['better-sqlite3', 'binding.gyp'],
        ['better-sqlite3', 'deps'],
        ['better-sqlite3', 'src'],
      ];
      for (const parts of rebuildFiles) {
        const source = path.resolve('node_modules', ...parts);
        const destination = path.join(buildPath, 'node_modules', ...parts);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(source, destination, { recursive: true });
      }
    },
    packageAfterPrune: async (_config, buildPath) => {
      // Capture the Electron rebuild (or a separately verified local fallback), then replace the
      // build tree with only the runtime files so source, logs, PDBs, and duplicate binaries do not
      // ship in the application.
      process.stdout.write(`[package] staging native runtime in ${buildPath}\n`);
      const nativeDestination = path.join(
        buildPath,
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node',
      );
      const nativeSource = verifiedPrebuiltNative
        ? path.resolve(verifiedPrebuiltNative)
        : nativeDestination;
      let nativeBinary: Buffer;
      try {
        nativeBinary = await fs.readFile(nativeSource);
      } catch (cause) {
        throw new Error(`Electron SQLite rebuild did not produce ${nativeSource}`, { cause });
      }

      await fs.rm(path.join(buildPath, 'node_modules', 'better-sqlite3'), {
        recursive: true,
        force: true,
      });
      const runtimeFiles = [
        ['better-sqlite3', 'package.json'],
        ['better-sqlite3', 'lib'],
        ['bindings', 'package.json'],
        ['bindings', 'bindings.js'],
        ['file-uri-to-path', 'package.json'],
        ['file-uri-to-path', 'index.js'],
      ];
      for (const parts of runtimeFiles) {
        const source = path.resolve('node_modules', ...parts);
        const destination = path.join(buildPath, 'node_modules', ...parts);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(source, destination, { recursive: true });
      }
      await fs.mkdir(path.dirname(nativeDestination), { recursive: true });
      await fs.writeFile(nativeDestination, nativeBinary);
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'apps/desktop/src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'apps/desktop/src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
