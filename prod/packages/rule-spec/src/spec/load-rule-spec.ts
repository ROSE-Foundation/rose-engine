// @rose/rule-spec — validated loading of a rule specification (Story 3.1).
//
// Boundary validation with Zod, mirroring `@rose/config`'s refuse-if-invalid idiom. A
// malformed spec is REFUSED with a typed error (never silently coerced) so a broken
// single-source can never reach codegen or the conformance harness.
import type { ZodError } from 'zod';
import { ruleSpecSchema, type RuleSpec } from './rule-spec-schema.js';

/** The version of the rule spec this package currently ships. */
export const RULE_SPEC_VERSION = '1.0.0' as const;

/**
 * Typed refusal raised when a rule-spec input fails schema validation. Carries the structured
 * Zod issues so callers/tests can inspect exactly what was wrong (cf. `ConfigRefusalError`).
 */
export class RuleSpecValidationError extends Error {
  override readonly name = 'RuleSpecValidationError';
  readonly issues: ZodError['issues'];

  constructor(issues: ZodError['issues']) {
    super(
      `Rule spec failed validation with ${issues.length} issue(s): ` +
        issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    );
    this.issues = issues;
  }
}

/**
 * Validate an unknown input against the rule-spec schema. Returns the typed {@link RuleSpec} on
 * success; throws {@link RuleSpecValidationError} on any violation (refuse, never coerce).
 */
export function loadRuleSpec(input: unknown): RuleSpec {
  const result = ruleSpecSchema.safeParse(input);
  if (!result.success) {
    throw new RuleSpecValidationError(result.error.issues);
  }
  return result.data;
}
