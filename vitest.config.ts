import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests run fully offline. The Postgres integration test is skipped unless DATABASE_URL is set.
    testTimeout: 15_000,
  },
});
