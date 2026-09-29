import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `vite dev` talks to a locally running server (VM target, default port 8080)
// through same-origin proxies, so the dev fallback config needs no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/config.json': 'http://localhost:8080',
      '/media': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { target: 'es2022' },
});
