// @rose/rule-spec — the reusable conformance harness (Story 3.1).
//
// Runs a set of vectors through any `PlaneAdapter` and reports pass/fail. Story 3.4 and Epic 4
// reuse THIS harness with the SAME vectors so off-chain and on-chain rules cannot diverge.
import type { ConformanceResult, ConformanceVector, PlaneAdapter } from './types.js';

/**
 * Run every vector whose `planes` include the adapter's plane. Vectors for other planes are
 * skipped (an on-chain-only vector is not asserted against an off-chain adapter).
 */
export function runConformance(
  adapter: PlaneAdapter,
  vectors: readonly ConformanceVector[],
): ConformanceResult[] {
  return vectors
    .filter((vector) => vector.planes.includes(adapter.plane))
    .map((vector) => {
      const actual = adapter.evaluate(vector.scenario, vector.env);
      return { vector, actual, passed: actual === vector.expected };
    });
}

/** Typed failure raised by {@link assertAllConform}, carrying the mismatching results. */
export class ConformanceFailureError extends Error {
  override readonly name = 'ConformanceFailureError';
  readonly failures: readonly ConformanceResult[];

  constructor(adapterName: string, failures: readonly ConformanceResult[]) {
    super(
      `Adapter "${adapterName}" failed ${failures.length} conformance vector(s): ` +
        failures
          .map((f) => `${f.vector.id} (expected ${f.vector.expected}, got ${f.actual})`)
          .join('; '),
    );
    this.failures = failures;
  }
}

/** Assert every result passed; throw {@link ConformanceFailureError} listing any mismatches. */
export function assertAllConform(
  adapter: PlaneAdapter,
  results: readonly ConformanceResult[],
): void {
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    throw new ConformanceFailureError(adapter.name, failures);
  }
}
