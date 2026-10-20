import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const consoleDir = fileURLToPath(new URL('.', import.meta.url));
// Two checkouts can run e2e on one machine by overriding the ports (defaults unchanged).
const apiPort = process.env.OVO_E2E_API_PORT ?? '4177';
const webPort = process.env.OVO_E2E_WEB_PORT ?? '3177';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'phone-390',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'tablet-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: `OVO_E2E_API_PORT=${apiPort} node e2e/auth-server.mjs`,
      cwd: consoleDir,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `OVO_API_URL=http://127.0.0.1:${apiPort} pnpm exec next start --hostname 127.0.0.1 --port ${webPort}`,
      cwd: consoleDir,
      url: `http://127.0.0.1:${webPort}/login`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
