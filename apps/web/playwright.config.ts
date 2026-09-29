import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// The descriptors for phones default to WebKit; only Chromium is installed here, so
// every project pins the browser explicitly.
const chromium = { browserName: 'chromium' as const };

// The preference passes (reduced motion, dark, forced colours, high contrast) and the
// scripted-server flows run once, on the 390 phone; every other project skips those files.
const phone390Only = /(preferences|flow)\.spec\.ts$/;

/** The six projects of ADR-0016 / research section 8. */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
  },
  projects: [
    {
      name: 'phone-320',
      testIgnore: phone390Only,
      use: { ...devices['iPhone SE'], ...chromium },
    },
    {
      name: 'phone-390',
      use: { ...devices['iPhone 14'], ...chromium, viewport: { width: 390, height: 844 } },
    },
    {
      name: 'tablet-768',
      testIgnore: phone390Only,
      use: { ...devices['iPad Mini'], ...chromium },
    },
    {
      name: 'laptop-1366',
      testIgnore: phone390Only,
      use: { ...devices['Desktop Chrome'], ...chromium, viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'hd-1920',
      testIgnore: phone390Only,
      use: { ...devices['Desktop Chrome'], ...chromium, viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'uhd-3840',
      testIgnore: phone390Only,
      use: { ...devices['Desktop Chrome'], ...chromium, viewport: { width: 3840, height: 2160 } },
    },
  ],
  webServer: {
    // A separate outDir keeps the gallery-enabled build away from `dist/`, which must
    // never contain gallery code.
    command: `pnpm exec vite build --outDir dist-e2e --emptyOutDir && pnpm exec vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    env: { VITE_ENABLE_GALLERY: '1' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
