import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'balance-book-development-csp',
      transformIndexHtml(html, context) {
        return context.server
          ? html.replace("connect-src 'self';", "connect-src 'self' ws:;")
          : html;
      },
    },
  ],
  build: {
    sourcemap: false,
  },
});
