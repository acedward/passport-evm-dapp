import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app is a static site. It bundles the browser-safe Passport client from
// @mnbank/core/passport (one compact-runtime, plan P0.4) and nothing that needs Node.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
});
