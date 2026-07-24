import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __BALANCE_BOOK_UPDATES_ENABLED__: JSON.stringify(
      process.env.BALANCE_BOOK_UPDATES_ENABLED === '1',
    ),
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
