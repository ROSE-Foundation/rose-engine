// @rose/rule-spec — the single source of truth for ROSE authorization rules (FR-19, §8 Q5).
//
// Public surface consumed by the off-chain plane (`authorization`, Story 3.4) and the on-chain
// plane (`contracts`, Epic 4). Both DERIVE their rules from the versioned spec + codegen here
// and prove equivalence via the shared conformance vectors — neither plane hand-authors rules.

/** Package identifier. */
export const RULE_SPEC_PACKAGE_NAME = '@rose/rule-spec' as const;

// Versioned declarative rule-spec grammar + vocabulary.
export * from './spec/rule-spec-schema.js';
// The concrete v1 spec (the source of truth).
export * from './spec/rule-spec.v1.js';
// Validated loading (refuse-if-invalid).
export * from './spec/load-rule-spec.js';
// Codegen: derive the off-chain policy artifact from the spec. Consumers call
// `generateOffChainPolicy(ruleSpecV1)` directly (pure, no fs) — the committed JSON artifact under
// `src/codegen/generated/` is the on-disk hand-off (drift guard + the Foundry/on-chain plane reads
// it from the repo path). The artifact PATH is intentionally NOT re-exported here: it resolves
// relative to the running module, and the JSON is not copied into `dist/` by `tsc`, so a built
// consumer must not depend on reading it via the package entry point.
export * from './codegen/generate-off-chain-policy.js';
// Conformance: shared vectors + reusable harness + reference off-chain adapter.
export * from './conformance/types.js';
export * from './conformance/vectors.js';
export * from './conformance/harness.js';
export * from './conformance/reference-off-chain-adapter.js';
