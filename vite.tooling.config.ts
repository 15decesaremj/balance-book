import path from 'node:path';
import { defineConfig } from 'vite';

const entry = process.env.BALANCE_BOOK_TOOL_ENTRY;
const outputName = process.env.BALANCE_BOOK_TOOL_OUTPUT;
if (!entry || !outputName) {
  throw new Error('BALANCE_BOOK_TOOL_ENTRY and BALANCE_BOOK_TOOL_OUTPUT are required');
}

export default defineConfig({
  build: {
    ssr: path.resolve(entry),
    outDir: path.resolve('local-release-work', 'compiled-tools'),
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      external: ['better-sqlite3'],
      output: { entryFileNames: outputName },
    },
  },
});
