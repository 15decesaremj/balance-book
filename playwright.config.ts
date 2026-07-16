import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  // Cold Windows native rebuilds happen in suite hooks, so keep their budget separate from
  // the journey body's tighter override in shell.e2e.ts.
  timeout: 300_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
