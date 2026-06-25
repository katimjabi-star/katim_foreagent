import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Web app lives in apps/web; build output ships inside the npm package (Sprint 4).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  server: {
    port: 5173,
    // Dev: Vite serves the UI, proxies API + SSE to the bun server on :3777.
    proxy: {
      '/api': {
        target: 'http://localhost:3777',
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => proxy.on('proxyReq', (pr) => pr.setHeader('accept-encoding', 'identity')),
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
