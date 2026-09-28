import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

// One random port per run (>= 10000), chosen once: workers inherit it through the environment.
process.env.E2E_PORT ??= String(10_000 + Math.floor(Math.random() * 40_000));
const port = Number(process.env.E2E_PORT);
const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: `${root}/test-results`,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  webServer: {
    command: `npx vite build web --logLevel warn && npx vite preview web --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
