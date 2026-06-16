// @rose/shared — the cross-cutting PROD package (money/BigInt + decimal-scale utils,
// glossary enums, error types, generated types). Story 1.1 seeds it as a minimal valid
// package so the toolchain (typecheck/lint/test/build) has real source to exercise.
// Domain utilities are added by later stories (money helpers: Story 1.2).

/** Package identifier. */
export const SHARED_PACKAGE_NAME = '@rose/shared' as const;

// Exact-money primitives (Story 1.2).
export * from './money.js';
