import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Throwaway TS test suites (epic 7, FR-15+) run in this gate too. Including them does NOT
    // weaken the regime boundary: the rule is an IMPORT direction (/prod ↮ /throwaway), enforced
    // by `pnpm check:regime` + eslint — running throwaway's own tests is orthogonal to it.
    include: [
      'prod/packages/**/*.test.ts',
      'prod/packages/**/*.test.tsx',
      'tools/**/*.test.mjs',
      'throwaway/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'prod/contracts/**'],
    // The ledger integration tests share one PostgreSQL database and run migrations
    // (down/up) that would clobber each other if files ran concurrently. Serialize files.
    fileParallelism: false,
  },
});
