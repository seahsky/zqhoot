import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Some tests boot a whole server or run a 5 s question timer on the real clock.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
