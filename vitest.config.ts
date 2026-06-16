import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['prod/packages/**/*.test.ts', 'tools/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', 'prod/contracts/**', 'throwaway/**'],
    // The ledger integration tests share one PostgreSQL database and run migrations
    // (down/up) that would clobber each other if files ran concurrently. Serialize files.
    fileParallelism: false,
  },
});
