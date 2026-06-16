// @rose/authorization — the `flow_permissions` policy store (Story 3.4, FR-8).
//
// Persists the GENERATED off-chain policy artifact into the DB and reads it back. The rules come
// from the SINGLE source of truth (`generateOffChainPolicy(ruleSpecV1)`, Story 3.1); this module
// only PROJECTS that artifact onto the `flow_permissions` table and reconstructs it — it authors no
// rule logic. The round-trip is byte-identical (a drift test proves it), so the DB-backed provider
// reproduces the reference semantics exactly.
import type { RoseExecutor } from '@rose/ledger';
import { flowPermissions } from '@rose/ledger';
import type {
  FloorGuard,
  FlowPermissionRule,
  OffChainPolicyArtifact,
  Prohibition,
} from '@rose/rule-spec';

/** Thrown when the `flow_permissions` table holds no policy — fail-closed (never a vacuous ALLOW). */
export class EmptyFlowPolicyError extends Error {
  constructor() {
    super(
      'Refusing to build an off-chain policy: the flow_permissions table is empty. ' +
        'Seed it from generateOffChainPolicy(ruleSpecV1) before serving authorization (NFR-4).',
    );
    this.name = 'EmptyFlowPolicyError';
  }
}

/** Thrown when persisted rows disagree on policy-level metadata — the seed is corrupt; fail-closed. */
export class InconsistentFlowPolicyError extends Error {
  constructor(field: string, values: readonly string[]) {
    super(
      `Refusing to build an off-chain policy: flow_permissions rows disagree on '${field}' ` +
        `(${values.join(', ')}). A single seeded artifact must be uniform (NFR-4).`,
    );
    this.name = 'InconsistentFlowPolicyError';
  }
}

/** Stable ascending sort by `id`, matching the codegen's deterministic ordering. */
function byId<T extends { readonly id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Map an artifact into one verbatim-payload row per clause (allow-rule / prohibition / floor guard). */
function artifactToRows(artifact: OffChainPolicyArtifact) {
  const common = {
    policyVersion: artifact.version,
    source: artifact._generated.source,
    generator: artifact._generated.generator,
    defaultEffect: artifact.defaultEffect,
  };
  return [
    ...artifact.allowRules.map((rule) => ({
      ...common,
      clauseKind: 'ALLOW_RULE' as const,
      clauseId: rule.id,
      payload: rule,
    })),
    ...artifact.prohibitions.map((prohibition) => ({
      ...common,
      clauseKind: 'PROHIBITION' as const,
      clauseId: prohibition.id,
      payload: prohibition,
    })),
    ...artifact.floorGuards.map((guard) => ({
      ...common,
      clauseKind: 'FLOOR_GUARD' as const,
      clauseId: guard.id,
      payload: guard,
    })),
  ];
}

/**
 * Seed the `flow_permissions` table from a generated artifact. Idempotent: clears any existing
 * policy and writes the current one, so re-seeding after a rule-spec change converges (the
 * `clause_id` UNIQUE constraint guarantees no duplicate clauses). Pass an open transaction as the
 * executor to compose the (delete + insert) atomically with surrounding work.
 */
export async function seedFlowPermissions(
  executor: RoseExecutor,
  artifact: OffChainPolicyArtifact,
): Promise<void> {
  const rows = artifactToRows(artifact);
  // Run the (delete + insert) atomically so a concurrent `loadOffChainPolicy` never observes the
  // intermediate empty table (which would spuriously throw EmptyFlowPolicyError). A drizzle
  // transaction works for both a pool and an in-flight transaction (nested ⇒ savepoint).
  await executor.transaction(async (tx) => {
    await tx.delete(flowPermissions);
    if (rows.length > 0) {
      await tx.insert(flowPermissions).values(rows);
    }
  });
}

/** Assert every row shares one value for a policy-level field; return it (else fail-closed). */
function uniformField(values: readonly string[], field: string): string {
  const distinct = [...new Set(values)];
  if (distinct.length !== 1) {
    throw new InconsistentFlowPolicyError(field, distinct);
  }
  return distinct[0]!;
}

/**
 * Extract the payloads for one clause kind, asserting each payload's own `id` matches the row's
 * `clause_id`. This is an integrity check on the persisted projection: a row whose `clause_kind` or
 * `payload` was tampered with (so the clause lands in the wrong bucket or carries a mismatched id)
 * is rejected rather than loaded verbatim into the rule set (fail-closed, NFR-4).
 */
function payloadsForKind<T extends { readonly id: string }>(
  rows: readonly { clauseKind: string; clauseId: string; payload: unknown }[],
  kind: string,
): T[] {
  return rows
    .filter((r) => r.clauseKind === kind)
    .map((r) => {
      const payload = r.payload as T | null;
      if (payload === null || typeof payload !== 'object' || payload.id !== r.clauseId) {
        throw new InconsistentFlowPolicyError('clause payload id', [
          r.clauseId,
          String((payload as { id?: unknown } | null)?.id),
        ]);
      }
      return payload;
    });
}

/**
 * Reconstruct the `OffChainPolicyArtifact` from the persisted `flow_permissions` rows. Byte-identical
 * to the codegen output for the same seed (so it can be fed straight into the reference adapter).
 * Fail-closed: an empty table or rows with inconsistent metadata throw rather than yield a permissive
 * or partial policy (NFR-4).
 */
export async function loadOffChainPolicy(executor: RoseExecutor): Promise<OffChainPolicyArtifact> {
  const rows = await executor.select().from(flowPermissions);
  if (rows.length === 0) {
    throw new EmptyFlowPolicyError();
  }

  const version = uniformField(
    rows.map((r) => r.policyVersion),
    'policy_version',
  );
  const source = uniformField(
    rows.map((r) => r.source),
    'source',
  );
  const generator = uniformField(
    rows.map((r) => r.generator),
    'generator',
  );
  const defaultEffect = uniformField(
    rows.map((r) => r.defaultEffect),
    'default_effect',
  );
  // Fail-closed: the off-chain default MUST be DENY — a persisted ALLOW/REFUSE default would not be
  // fail-closed, and the artifact contract pins it to 'DENY'.
  if (defaultEffect !== 'DENY') {
    throw new InconsistentFlowPolicyError('default_effect', [defaultEffect, 'DENY (required)']);
  }

  const allowRules = byId(payloadsForKind<FlowPermissionRule>(rows, 'ALLOW_RULE'));
  const prohibitions = byId(payloadsForKind<Prohibition>(rows, 'PROHIBITION'));
  const floorGuards = byId(payloadsForKind<FloorGuard>(rows, 'FLOOR_GUARD'));

  return {
    _generated: { source, version, generator },
    version,
    defaultEffect: 'DENY',
    allowRules,
    prohibitions,
    floorGuards,
  };
}
