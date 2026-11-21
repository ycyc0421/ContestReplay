import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './studio/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3100', headless: true, viewport: { width: 1440, height: 960 } },
  webServer: {
    command: 'node dist/cli.js studio --port 3100 --workspace /tmp/contestreplay-studio-e2e',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
