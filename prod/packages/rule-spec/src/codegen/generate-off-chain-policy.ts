// @rose/rule-spec — codegen: derive the off-chain policy artifact from the rule spec (Story 3.1).
//
// `generateOffChainPolicy` is a PURE, DETERMINISTIC function: same spec in ⇒ byte-identical
// artifact out (stable id ordering). It is the codegen entry point for the OFF-CHAIN plane —
// the artifact it emits is the precursor of the Story-3.4 `flow_permissions` rows and the
// config the production `OffChainPolicyProvider` consumes. Epic 4 adds an analogous on-chain
// emitter from the SAME spec. Nothing here touches a DB, the network, or `postTransfer`.
import type {
  AccountTypeCode,
  AssetKind,
  Classification,
  DestinationKind,
  EntityCode,
  RuleSpec,
} from '../spec/rule-spec-schema.js';

/** Provenance stamped into the artifact so a reader knows it is generated, not hand-authored. */
export interface ArtifactProvenance {
  readonly source: string;
  readonly version: string;
  readonly generator: string;
}

/** A permitted flow — the off-chain `flow_permissions` row precursor (Story 3.4). */
export interface FlowPermissionRule {
  readonly id: string;
  readonly from: { readonly accountType: AccountTypeCode; readonly classification: Classification };
  readonly to: DestinationKind;
  readonly effect: 'ALLOW';
}

/** A derived prohibition: principal egress (Model-A) or token-flow-through-entity (VCC). */
export type Prohibition =
  | {
      readonly id: string;
      readonly kind: 'PRINCIPAL_EGRESS';
      readonly protectedAccountType: AccountTypeCode;
      readonly protectedClassification: Classification;
      readonly allowedDestination: DestinationKind;
    }
  | {
      readonly id: string;
      readonly kind: 'ROUTE_THROUGH_ENTITY';
      readonly entity: EntityCode;
      readonly assetKind: AssetKind;
    };

/**
 * A floor guard the runtime provider must enforce (floor value resolved from config, NFR-4).
 * It is scoped to the specific allow-rule it guards (`allowRuleId`) — NOT to every flow from the
 * account — so adding an unguarded second flow from the same account does not inherit the floor.
 */
export interface FloorGuard {
  readonly id: string;
  readonly allowRuleId: string;
  readonly accountType: AccountTypeCode;
  readonly floorConfigKey: string;
}

/** The generated off-chain policy artifact. `defaultEffect` is DENY (fail-closed). */
export interface OffChainPolicyArtifact {
  readonly _generated: ArtifactProvenance;
  readonly version: string;
  readonly defaultEffect: 'DENY';
  readonly allowRules: readonly FlowPermissionRule[];
  readonly prohibitions: readonly Prohibition[];
  readonly floorGuards: readonly FloorGuard[];
}

const GENERATOR_ID = '@rose/rule-spec/codegen/generate-off-chain-policy';

/** Stable ascending sort by `id` so re-generation is byte-identical (drift-detectable). */
function byId<T extends { readonly id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Derive the off-chain policy artifact from a validated rule spec. Deterministic and pure.
 *
 * - Each `transferRestrictions.allow` rule becomes a `FlowPermissionRule` (effect ALLOW); a
 *   rule carrying a `floorGuard` additionally yields a `FloorGuard` keyed to its source account.
 * - The `modelABrightLine` section yields a `PRINCIPAL_EGRESS` prohibition (principal may only
 *   move to `CLIENT_ACCOUNT`).
 * - Each `transferRestrictions.prohibit` rule yields a `ROUTE_THROUGH_ENTITY` prohibition.
 */
export function generateOffChainPolicy(spec: RuleSpec): OffChainPolicyArtifact {
  const allowRules: FlowPermissionRule[] = spec.transferRestrictions.allow.map((rule) => ({
    id: rule.id,
    from: { accountType: rule.from.accountType, classification: rule.from.classification },
    to: rule.to,
    effect: 'ALLOW',
  }));

  const floorGuards: FloorGuard[] = spec.transferRestrictions.allow
    .filter((rule) => rule.floorGuard !== undefined)
    .map((rule) => ({
      id: `floor-${rule.id}`,
      allowRuleId: rule.id,
      accountType: rule.from.accountType,
      // Narrowed by the filter above; assert presence for the type checker.
      floorConfigKey: (rule.floorGuard as { floorConfigKey: string }).floorConfigKey,
    }));

  const prohibitions: Prohibition[] = [
    {
      id: 'prohibit-model-a-principal-egress',
      kind: 'PRINCIPAL_EGRESS',
      protectedAccountType: spec.modelABrightLine.protectedAccountType,
      protectedClassification: spec.modelABrightLine.protectedClassification,
      allowedDestination: 'CLIENT_ACCOUNT',
    },
    ...spec.transferRestrictions.prohibit.map(
      (rule): Prohibition => ({
        id: rule.id,
        kind: 'ROUTE_THROUGH_ENTITY',
        entity: rule.match.entity,
        assetKind: rule.match.assetKind,
      }),
    ),
  ];

  return {
    _generated: { source: 'rule-spec.v1', version: spec.version, generator: GENERATOR_ID },
    version: spec.version,
    defaultEffect: 'DENY',
    allowRules: byId(allowRules),
    prohibitions: byId(prohibitions),
    floorGuards: byId(floorGuards),
  };
}

/** Serialize an artifact to canonical JSON (2-space indent, trailing newline) for on-disk emit. */
export function serializeArtifact(artifact: OffChainPolicyArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
