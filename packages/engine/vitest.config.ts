import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      // On by default so `pnpm --filter @zqhoot/engine test` enforces the thresholds.
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Type-only and pure re-export modules have no statements to cover.
      exclude: ['src/index.ts', 'src/model.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
