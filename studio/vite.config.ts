import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const studioOrigin = process.env.STUDIO_ORIGIN ?? 'http://127.0.0.1:3000';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src'), '@studio-api': resolve(import.meta.dirname, '../runner/studio-contract.ts') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: studioOrigin, changeOrigin: true, headers: { Origin: studioOrigin } } },
  },
  build: {
    outDir: resolve(import.meta.dirname, '../dist/studio'), emptyOutDir: true, assetsInlineLimit: 0,
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: 'react-vendor', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
      { name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/ },
      { name: 'motion', test: /node_modules[\\/](?:motion|motion-dom|motion-utils)[\\/]/ },
    ] } } },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['./src/**/*.test.{ts,tsx}'],
  },
});
