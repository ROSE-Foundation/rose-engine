// @rose/rule-spec — the versioned declarative rule-spec schema (Story 3.1, FR-19 / §8 Q5).
//
// This module is the single source of truth's *grammar*: a Zod schema describing the shape
// of a rule specification plus the rule vocabulary it speaks. The off-chain plane
// (`authorization`, Story 3.4) and the on-chain plane (`contracts`, Epic 4) DERIVE their
// rules from a spec validated here — they never hand-author rules. The schema is a leaf:
// it imports only `zod` (architecture §Architectural Boundaries "Rule boundary").
//
// Vocabulary note: the account-type and entity codes below MIRROR the PRD glossary enums
// that live as drizzle `pgEnum`s in `@rose/ledger` (`accounts.account_type`,
// `entities.entity_code`). They are declared here — not imported — so the rule language
// stays self-contained and the source-of-truth never depends on a consumer. Any
// "the two are identical" assertion belongs on the consumer side (Story 3.4), never as a
// `rule-spec → ledger` import.
import { z } from 'zod';

/** The five fixed account types — PRD glossary (mirrors `@rose/ledger` `account_type`). */
export const accountTypeCodeSchema = z.enum([
  'BACKING_FLOAT',
  'DEPLOYED_CAPITAL',
  'CLIENT_COLLATERAL',
  'FEE_INCOME',
  'NOTE_LIABILITY',
]);
export type AccountTypeCode = z.infer<typeof accountTypeCodeSchema>;

/** The four fixed entity codes — PRD glossary (mirrors `@rose/ledger` `entity_code`). */
export const entityCodeSchema = z.enum(['VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER']);
export type EntityCode = z.infer<typeof entityCodeSchema>;

/**
 * Capital classification for the Model-A bright line. `PRINCIPAL` and `YIELD` apply to
 * `CLIENT_COLLATERAL` movements (principal is ring-fenced; yield may be swept). `NONE` is
 * used where the distinction does not apply (e.g. fee income).
 */
export const classificationSchema = z.enum(['PRINCIPAL', 'YIELD', 'NONE']);
export type Classification = z.infer<typeof classificationSchema>;

/** Logical destination of a capital movement (not a concrete account id — that is runtime). */
export const destinationKindSchema = z.enum(['TREASURY', 'CLIENT_ACCOUNT', 'EXTERNAL']);
export type DestinationKind = z.infer<typeof destinationKindSchema>;

/** What is moving: economic VALUE vs a TOKEN quantity (token/trading flows must not route VCC). */
export const assetKindSchema = z.enum(['VALUE', 'TOKEN']);
export type AssetKind = z.infer<typeof assetKindSchema>;

/** The three terminal decisions. Default-deny ⇒ `DENY` is the fail-closed baseline (NFR-4). */
export const effectSchema = z.enum(['ALLOW', 'DENY', 'REFUSE']);
export type Effect = z.infer<typeof effectSchema>;

/** Semantic-version string, e.g. `1.0.0`. */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'version must be a semver string like "1.0.0"');

/**
 * A floor guard attached to an egress allow-rule: the source account may not be drawn below
 * a floor whose value is a parked/config parameter resolved at runtime (Story 3.4 via
 * `@rose/config`). The spec carries only the config KEY — never a baked numeric floor — so an
 * absent floor is refused, never silently treated as 0 (NFR-4).
 */
export const floorGuardRefSchema = z
  .object({
    floorConfigKey: z.string().min(1),
  })
  .strict();
export type FloorGuardRef = z.infer<typeof floorGuardRefSchema>;

/** An allow-rule: a specific (from accountType+classification → destination) flow is permitted. */
export const allowRuleSchema = z
  .object({
    id: z.string().min(1),
    from: z
      .object({
        accountType: accountTypeCodeSchema,
        classification: classificationSchema,
      })
      .strict(),
    to: destinationKindSchema,
    floorGuard: floorGuardRefSchema.optional(),
  })
  .strict();
export type AllowRule = z.infer<typeof allowRuleSchema>;

/**
 * A structural prohibition that denies a class of flow regardless of any allow-rule. P0 uses
 * the `ROUTE_THROUGH_ENTITY` shape to encode "token/trading flows do not route through VCC
 * accounts". (The Model-A principal prohibition is derived from `modelABrightLine`, not here,
 * to keep that bright line single-sourced.)
 */
export const prohibitRuleSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    match: z
      .object({
        kind: z.literal('ROUTE_THROUGH_ENTITY'),
        entity: entityCodeSchema,
        assetKind: assetKindSchema,
      })
      .strict(),
  })
  .strict();
export type ProhibitRule = z.infer<typeof prohibitRuleSchema>;

/** Eligibility contract: allowlist + required ONCHAINID claim topics (Epic 4 maps to chain). */
export const eligibilitySchema = z
  .object({
    requireAllowlist: z.boolean(),
    requiredClaimTopics: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Eligibility = z.infer<typeof eligibilitySchema>;

/** Transfer restrictions: the allow-list of permitted flows plus structural prohibitions. */
export const transferRestrictionsSchema = z
  .object({
    allow: z.array(allowRuleSchema).min(1),
    prohibit: z.array(prohibitRuleSchema),
  })
  .strict();
export type TransferRestrictions = z.infer<typeof transferRestrictionsSchema>;

/**
 * The Model-A bright line: ring-fenced principal of the protected account must never leave the
 * client account (UJ-3). Single-sourced here; the off-chain prohibition and the on-chain
 * compliance rule are both DERIVED from this section.
 */
export const modelABrightLineSchema = z
  .object({
    protectedAccountType: accountTypeCodeSchema,
    protectedClassification: classificationSchema,
    rule: z.literal('PRINCIPAL_MUST_NOT_LEAVE_CLIENT'),
  })
  .strict();
export type ModelABrightLine = z.infer<typeof modelABrightLineSchema>;

/** Pair coupling: paired mint/burn is atomic; a single leg is forbidden ("never a single leg"). */
export const pairCouplingSchema = z
  .object({
    atomicPairedMintBurn: z.boolean(),
    singleLegForbidden: z.boolean(),
  })
  .strict();
export type PairCoupling = z.infer<typeof pairCouplingSchema>;

/**
 * The complete versioned rule specification. Fail-closed: `defaultEffect` is `DENY`, so any
 * flow not matched by an allow-rule is rejected (NFR-4). All four mandated sections
 * (eligibility, transfer restrictions, Model-A bright line, pair coupling) are required.
 */
/** Rule ids the codegen derives internally; authored ids must not collide with these. */
const RESERVED_PROHIBITION_ID = 'prohibit-model-a-principal-egress';
const RESERVED_FLOOR_ID_PREFIX = 'floor-';

export const ruleSpecSchema = z
  .object({
    version: semverSchema,
    defaultEffect: z.literal('DENY'),
    eligibility: eligibilitySchema,
    transferRestrictions: transferRestrictionsSchema,
    modelABrightLine: modelABrightLineSchema,
    pairCoupling: pairCouplingSchema,
  })
  .strict()
  // Integrity guard: rule ids must be unique and must not collide with codegen-reserved ids, so a
  // spec edit can never silently emit a duplicated/ambiguous generated artifact (single-source).
  .superRefine((spec, ctx) => {
    const ids = [
      ...spec.transferRestrictions.allow.map((r) => r.id),
      ...spec.transferRestrictions.prohibit.map((r) => r.id),
    ];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate rule id "${id}" — allow/prohibit ids must be unique`,
          path: ['transferRestrictions'],
        });
      }
      seen.add(id);
      if (id.startsWith(RESERVED_FLOOR_ID_PREFIX) || id === RESERVED_PROHIBITION_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rule id "${id}" is reserved for codegen-derived rules`,
          path: ['transferRestrictions'],
        });
      }
    }
  });
export type RuleSpec = z.infer<typeof ruleSpecSchema>;
