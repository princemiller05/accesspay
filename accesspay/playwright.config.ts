import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  // Runs the real server (gateway + shop + built frontend), like production.
  webServer: {
    command: 'npm run build && node server/main.ts',
    url: 'http://localhost:4173/healthz',
    env: { PORT: '4173' },
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Optional: point at an installed Chrome instead of Playwright's download.
        launchOptions: { executablePath: process.env.CHROME_PATH || undefined },
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath: process.env.CHROME_PATH || undefined } },
    },
  ],
});
