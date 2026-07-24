import { spawnSync } from 'node:child_process';
import path from 'node:path';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('pnpm executable path is unavailable');

const run = (label, command, args) => {
  process.stdout.write(`\n[verify] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
};

for (const script of ['format:check', 'lint', 'typecheck']) {
  run(script, process.execPath, [pnpmCli, script]);
}
run('native database rebuild for Node', process.execPath, [pnpmCli, 'rebuild', 'better-sqlite3']);
run('test', process.execPath, [
  path.resolve('node_modules', 'vitest', 'dist', 'cli.js'),
  'run',
  'tests',
  '--pool=forks',
  '--maxWorkers=1',
  '--testTimeout=30000',
]);
for (const script of ['privacy:check']) {
  run(script, process.execPath, [pnpmCli, script]);
}
run('production package', process.execPath, [
  path.resolve('node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js'),
  'package',
]);
run('Electron end-to-end', process.execPath, [
  path.resolve('node_modules', '@playwright', 'test', 'cli.js'),
  'test',
  '--config',
  'playwright.config.ts',
]);

process.stdout.write('\n[verify] all checks passed\n');
