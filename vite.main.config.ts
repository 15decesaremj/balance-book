import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __BALANCE_BOOK_UPDATES_ENABLED__: JSON.stringify(
      process.env.BALANCE_BOOK_UPDATES_ENABLED === '1',
    ),
    __BALANCE_BOOK_BUILD_CHANNEL__: JSON.stringify(
      process.env.BALANCE_BOOK_BUILD_CHANNEL === 'store' ? 'store' : 'direct',
    ),
    __BALANCE_BOOK_STORE_DATA_DIRECTORY__: JSON.stringify(
      process.env.BALANCE_BOOK_STORE_DATA_DIRECTORY ?? 'Balance Book Store',
    ),
    __BALANCE_BOOK_LEGACY_DATA_DIRECTORY__: JSON.stringify(
      process.env.BALANCE_BOOK_LEGACY_DATA_DIRECTORY ?? 'Balance Book',
    ),
    __BALANCE_BOOK_STORE_PRODUCT_ID__: JSON.stringify(
      process.env.BALANCE_BOOK_STORE_PRODUCT_ID ?? '',
    ),
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
