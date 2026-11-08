import { defineConfig, devices } from '@playwright/test';

// Runs against the stack in containers (pnpm stack:up), with the dashboard
// at WEB_URL. CI starts it with 1-second retry delays, so a delivery runs
// out of attempts in seconds.
export default defineConfig({
  testDir: './src',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
