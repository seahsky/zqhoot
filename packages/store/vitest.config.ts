import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // DynamoDB round trips add up in the contract suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
