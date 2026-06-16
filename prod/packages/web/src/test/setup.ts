// Shared setup for the @rose/web component tests. Imported at the top of each `*.test.tsx`
// (which also carries a `// @vitest-environment jsdom` pragma). Registers the jest-dom matchers
// and a per-test DOM cleanup — without a global Vitest `setupFiles`/`globals` change that would
// otherwise load into the node-environment, Postgres-backed backend tests.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
