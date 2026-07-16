import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
