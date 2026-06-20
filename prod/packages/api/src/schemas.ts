// Zod I/O schemas for the typed REST boundary (Story 6.1, FR-14 foundation). These schemas are the
// SINGLE SOURCE of the boundary's input/output types: the request/response validators run against
// them AND `@fastify/swagger` derives the OpenAPI document from them (no hand-maintained second
// copy). NFR-2: every monetary VALUE crosses the wire as a STRING (decimal or raw smallest-unit
// integer) — never a JS `number`/float, and never a `bigint`. `scale` is metadata (a decimal-place
// count), not a money value, so it stays a number.
// Imported from `zod/v4` (the workspace zod is 3.25.76, which ships the v4 API at this subpath):
// `fastify-type-provider-zod@5` infers request/response types via `zod/v4/core` `$ZodType`, so the
// schemas MUST be the v4 variant for end-to-end type inference + OpenAPI derivation to work.
import { z } from 'zod/v4';

// ─── Fixed vocabularies (mirror the @rose/ledger model — do NOT invent) ─────────────────────────

/** The four fixed entities. */
export const EntityCodeSchema = z.enum(['VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER']);

/** The five fixed account types. */
export const AccountTypeSchema = z.enum([
  'BACKING_FLOAT',
  'DEPLOYED_CAPITAL',
  'CLIENT_COLLATERAL',
  'FEE_INCOME',
  'NOTE_LIABILITY',
]);

/** The six fixed coupled-pair lifecycle states (FR-4). */
export const CoupledPairStateSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'REBALANCING',
  'PARTIAL',
  'SETTLING',
  'CLOSED',
]);

/** A double-entry posting direction. */
export const PostingDirectionSchema = z.enum(['DEBIT', 'CREDIT']);

/** An account's role in NAV. */
export const NavRoleSchema = z.enum(['ASSET', 'LIABILITY', 'EQUITY']);

/** The data source label (D3 — chain authoritative when aggregated). */
export const SourceSchema = z.enum(['ledger-only', 'ledger+chain']);

// A raw integer (smallest-units) carried as a string — optional sign, digits only, no exponent/float.
const INTEGER_STRING = z
  .string()
  .regex(/^-?\d+$/, 'must be an integer smallest-units string (no float, no exponent)');

// A plain decimal string — optional sign, digits, optional fractional part. No exponent, no NaN.
const DECIMAL_STRING = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string (no float artifacts, no exponent)');

// ─── Money ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A money amount over the wire (NFR-2): the asset, its decimal scale, the raw smallest-unit integer
 * as a STRING, and the exact formatted decimal as a STRING. Both string forms derive from the ONE
 * `bigint` integer source on the server — the client never sees a JS `number` money value.
 */
export const MoneySchema = z
  .object({
    asset: z.string().describe('Asset symbol (e.g. EUR, USD, ROSE-L).'),
    scale: z
      .number()
      .int()
      .nonnegative()
      .describe('Decimal scale (smallest-units per whole unit).'),
    smallestUnits: INTEGER_STRING.describe('Raw amount in smallest units, as a string.'),
    decimal: DECIMAL_STRING.describe('Exact decimal value formatted at `scale`, as a string.'),
  })
  .describe('A monetary amount; every value is a string (never a JS number/float).');

// ─── Coupled pair (read) ──────────────────────────────────────────────────────────────────────

/**
 * A coupled pair as returned by `GET /coupled-pairs/:id`. The smallest-unit magnitudes K/V_A/V_B
 * cross as raw integer strings (the `coupled_pairs` row carries no per-leg decimal scale, so the
 * boundary fabricates none — the `@rose/reconcile` precedent); anchor/leverage/floor cross as their
 * stored decimal strings; timestamps as ISO-8601 strings.
 */
export const CoupledPairSchema = z
  .object({
    id: z.string().uuid(),
    referenceAsset: z.string(),
    anchorPrice: DECIMAL_STRING,
    leverage: DECIMAL_STRING,
    collateralPool: INTEGER_STRING.describe('K — collateral pool, raw smallest-units string.'),
    floor: DECIMAL_STRING,
    longLegValue: INTEGER_STRING.describe('V_A — long-leg value, raw smallest-units string.'),
    shortLegValue: INTEGER_STRING.describe('V_B — short-leg value, raw smallest-units string.'),
    state: CoupledPairStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe('A coupled pair; smallest-unit magnitudes are integer strings (NFR-2).');

// ─── Rose Note (read) ─────────────────────────────────────────────────────────────────────────

/** A Rose Note as returned by `GET /rose-notes/:id` — the persisted Note↔pair embedding. */
export const RoseNoteSchema = z
  .object({
    id: z.string().uuid(),
    coupledPairId: z.string().uuid(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe('A Rose Note embedding exactly one coupled pair.');

// ─── Rose Note subscription (write — Story 6.2, FR-11) ──────────────────────────────────────────

// A 20-byte EVM address over the wire (the on-chain mint + viem validate strictly downstream).
const EVM_ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte EVM address (0x + 40 hex chars)');

// A POSITIVE smallest-units integer string (no sign, no zero) — a subscription amount must be > 0.
// Rejected cleanly at the boundary (400) rather than deferred to a downstream 422 (NFR-2).
const POSITIVE_INTEGER_STRING = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer smallest-units string (no float, no sign)')
  .refine((v) => {
    try {
      return BigInt(v) > 0n;
    } catch {
      return false;
    }
  }, 'amount must be a positive integer in smallest units (> 0)');

/** A subscription's lifecycle status (pending until commit, confirmed at the commit point, or failed). */
export const SubscriptionStatusSchema = z.enum(['pending', 'confirmed', 'failed']);

/**
 * The body of `POST /rose-notes/:id/subscriptions` (NFR-2: the subscription `amount` crosses the wire
 * as a raw smallest-units INTEGER STRING, never a JS number/float). The Rose Note id is the `:id`
 * path param; `subscriber` is the recipient EVM address; `idempotencyKey` makes the subscribe
 * exactly-once (NFR-9).
 */
export const SubscribeRequestSchema = z
  .object({
    subscriber: EVM_ADDRESS.describe(
      'Recipient EVM address (receives both legs of the paired position).',
    ),
    amount: POSITIVE_INTEGER_STRING.describe(
      'Subscription amount in smallest units, a positive integer string (NFR-2).',
    ),
    paymentAsset: z.string().min(1).describe('Payment asset (fiat or crypto).'),
    idempotencyKey: z
      .string()
      .min(1)
      .describe('Idempotency key — exactly-once subscription (NFR-9).'),
  })
  .describe('A Rose Note subscription request; the amount is a smallest-units string (NFR-2).');

/**
 * A subscription as returned by `POST /rose-notes/:id/subscriptions` and `GET /subscriptions/:id`. It
 * stays `pending` (submitted on-chain, no journal entry) until the on-chain commit point flips it to
 * `confirmed` (carrying the posted `journalEntryId`) — no optimistic success (UX-DR6). `amount` is a
 * smallest-units integer string (NFR-2).
 */
export const SubscriptionSchema = z
  .object({
    id: z.string().describe('The idempotency key — the stable subscription handle.'),
    roseNoteId: z.string(),
    coupledPairId: z.string(),
    subscriber: z.string(),
    amount: INTEGER_STRING,
    paymentAsset: z.string(),
    status: SubscriptionStatusSchema,
    txHash: z.string().nullable(),
    journalEntryId: z.string().nullable(),
  })
  .describe('A Rose Note subscription; pending until the on-chain commit point, then confirmed.');

/** The inferred wire type of a subscription (the surface consumer's response type — Story 6.6). */
export type SubscriptionResponse = z.infer<typeof SubscriptionSchema>;

/** The inferred wire type of a subscription request body (Story 6.6). */
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

/** A `:id` path parameter for a subscription id (the idempotency key — a non-empty string, not a UUID). */
export const SubscriptionIdParamSchema = z.object({ id: z.string().min(1) });

// ─── Rose Note redemption (write — Story 6.3, FR-11) ────────────────────────────────────────────

/** A redemption's lifecycle status (pending until commit, confirmed at the commit point, or failed). */
export const RedemptionStatusSchema = z.enum(['pending', 'confirmed', 'failed']);

/**
 * The body of `POST /rose-notes/:id/redemptions` (NFR-2: the redemption `amount` crosses the wire as a
 * raw smallest-units INTEGER STRING, never a JS number/float). The Rose Note id is the `:id` path
 * param; `redeemer` is the holder EVM address (retires both legs); `idempotencyKey` makes the redeem
 * exactly-once (NFR-9). The INVERSE mirror of `SubscribeRequestSchema`.
 */
export const RedeemRequestSchema = z
  .object({
    redeemer: EVM_ADDRESS.describe(
      'Holder EVM address (retires both legs of the paired position being bought back).',
    ),
    amount: POSITIVE_INTEGER_STRING.describe(
      'Redemption amount in smallest units, a positive integer string (NFR-2).',
    ),
    paymentAsset: z.string().min(1).describe('Payment asset (fiat or crypto).'),
    idempotencyKey: z
      .string()
      .min(1)
      .describe('Idempotency key — exactly-once redemption (NFR-9).'),
  })
  .describe('A Rose Note redemption request; the amount is a smallest-units string (NFR-2).');

/**
 * A redemption as returned by `POST /rose-notes/:id/redemptions` and `GET /redemptions/:id`. It stays
 * `pending` (burn submitted on-chain, no journal entry) until the on-chain commit point flips it to
 * `confirmed` (carrying the posted `journalEntryId`, the position closes) — no optimistic success
 * (UX-DR6). `amount` is a smallest-units integer string (NFR-2).
 */
export const RedemptionSchema = z
  .object({
    id: z.string().describe('The idempotency key — the stable redemption handle.'),
    roseNoteId: z.string(),
    coupledPairId: z.string(),
    redeemer: z.string(),
    amount: INTEGER_STRING,
    paymentAsset: z.string(),
    status: RedemptionStatusSchema,
    txHash: z.string().nullable(),
    journalEntryId: z.string().nullable(),
  })
  .describe('A Rose Note redemption; pending until the on-chain commit point, then confirmed.');

/** The inferred wire type of a redemption (the surface consumer's response type — Story 6.6). */
export type RedemptionResponse = z.infer<typeof RedemptionSchema>;

/** The inferred wire type of a redemption request body (Story 6.6). */
export type RedeemRequest = z.infer<typeof RedeemRequestSchema>;

/** A `:id` path parameter for a redemption id (the idempotency key — a non-empty string, not a UUID). */
export const RedemptionIdParamSchema = z.object({ id: z.string().min(1) });

// ─── Per-user positions + live P&L (read — Story 8.4, FR-26) ────────────────────────────────────

// A SIGNED smallest-units integer string (P&L can be negative — the losing leg's loss). NFR-2.
const SIGNED_INTEGER_STRING = z
  .string()
  .regex(/^-?\d+$/, 'must be a signed integer smallest-units string (no float, no exponent)');

/** The directional side of a per-user position (PRD glossary L/S). */
export const PositionSideSchema = z.enum(['LONG', 'SHORT']);

/** The position lifecycle (OPEN → CLOSED; RESET is an event, not a state — 8.2). */
export const PositionLifecycleSchema = z.enum(['OPEN', 'CLOSED']);

/** The explicit mark state (8.1). A non-`OK` state never carries a trusted price/P&L. */
export const MarkStatusSchema = z.enum(['OK', 'STALE', 'NO_FEED', 'DIVERGENT']);

/** Provenance of the oracle quote a mark was derived from (8.1). Null when there is no feed. */
const MarkProvenanceSchema = z.object({
  source: z.string(),
  asOf: z.string().datetime(),
  sequence: z.number().int().optional(),
});

/**
 * A position's live mark (8.1 `markToMarket` over the linked coupled pair). The trusted fields
 * (`markPrice` for STALE/DIVERGENT is the surfaced-but-untrusted figure, `unrealizedPnl`,
 * `distanceToFloor`) are non-null ONLY when `status === 'OK'`; otherwise null (a mark is NEVER
 * fabricated). `markPrice` is null only for `NO_FEED`. Prices/floor/distance are decimal strings;
 * the directional `unrealizedPnl` is a signed smallest-units integer string (NFR-2).
 */
export const PositionMarkSchema = z
  .object({
    status: MarkStatusSchema,
    entryPrice: DECIMAL_STRING.describe('Entry price = anchor P₀ (decimal string).'),
    markPrice: DECIMAL_STRING.nullable().describe(
      'Oracle price used (decimal string); null only for NO_FEED. Surfaced-but-untrusted for STALE/DIVERGENT.',
    ),
    floor: DECIMAL_STRING.describe('Floor f (decimal string) — always surfaced (a pair param).'),
    distanceToFloor: DECIMAL_STRING.nullable().describe(
      'distance-to-floor = buffer(1 − |L·r|) − f (decimal); null unless OK.',
    ),
    unrealizedPnl: SIGNED_INTEGER_STRING.nullable().describe(
      "The position side's unrealized P&L in smallest units (signed integer string); null unless OK.",
    ),
    floorBreached: z.boolean().nullable().describe('True when buffer ≤ f; null unless OK.'),
    provenance: MarkProvenanceSchema.nullable(),
    // `ageMs`/`freshnessBoundMs` are not money — `freshnessBoundMs` is a caller-supplied trust bound
    // (`markToMarket` accepts any finite non-negative number), so the schema does NOT require an
    // integer (a fractional bound must not fail response serialization).
    ageMs: z.number().nullable().describe('Quote age (ms) at evaluation; null when no feed.'),
    freshnessBoundMs: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'The freshness bound (ms) the mark was evaluated against; null when no trust input.',
      ),
    flags: z
      .array(z.string())
      .describe('Every reason the mark is not a plain OK (e.g. ["STALE"]).'),
  })
  .describe('A position live mark; trusted fields null unless OK — never a fabricated mark (§15).');

/**
 * A per-user position as returned by `GET /positions` (FR-26). Smallest-unit magnitudes
 * (`sizeUnits`/`collateral`/`realizedPnl`) cross as raw smallest-unit integer strings — the
 * positions row carries no per-token decimal scale, so the boundary fabricates none (the 6.1
 * coupled-pair-magnitude precedent); `entryPrice`/`leverage` cross as decimal strings; the live
 * `mark` carries the directional P&L. Every monetary value is a STRING (NFR-2).
 */
export const PositionSchema = z
  .object({
    id: z.string().uuid(),
    coupledPairId: z.string().uuid(),
    owner: z.string(),
    referenceAsset: z.string(),
    side: PositionSideSchema,
    sizeUnits: INTEGER_STRING.describe('Size/units — raw smallest-units string.'),
    entryPrice: DECIMAL_STRING.describe('Entry = anchor P₀ (decimal string, decimal(18,8)).'),
    collateral: INTEGER_STRING.describe('Collateral — raw smallest-units string.'),
    leverage: DECIMAL_STRING.describe('Leverage (decimal string; pinned 1x in P0).'),
    realizedPnl: SIGNED_INTEGER_STRING.describe('Realized P&L — signed smallest-units string.'),
    lifecycle: PositionLifecycleSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    mark: PositionMarkSchema,
  })
  .describe('A per-user position + its live mark; money values are strings (NFR-2).');

/** The inferred wire type of a position (the surface consumer's response type — Story 8.4). */
export type PositionResponse = z.infer<typeof PositionSchema>;

/** The inferred wire type of a position mark (Story 8.4). */
export type PositionMarkResponse = z.infer<typeof PositionMarkSchema>;

/** `GET /positions` response — the owner echoed back + their positions with live marks. */
export const PositionsResponseSchema = z
  .object({
    owner: z.string(),
    positions: z.array(PositionSchema),
  })
  .describe('A per-user positions listing with live marks (FR-26).');

/** The inferred wire type of the positions listing (Story 8.4). */
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

/**
 * The `GET /positions` query string: `owner` (required, non-empty) + an optional `referenceAsset`
 * narrowing. A missing/empty owner ⇒ 400 at the boundary (Zod), never an unscoped listing.
 */
export const PositionsQuerySchema = z.object({
  owner: z.string().min(1).describe('The per-user owner reference (required).'),
  referenceAsset: z.string().min(1).optional().describe('Optional reference-asset narrowing.'),
});

// ─── Open/close a directional position (write — Stories 8.3/8.6, FR-25) ─────────────────────────

/** A position open/close flow's lifecycle status (pending until commit, confirmed, or failed). */
export const PositionFlowStatusSchema = z.enum(['pending', 'confirmed', 'failed']);

/**
 * The body of `POST /positions/open` (NFR-2: `amount` crosses the wire as a raw smallest-units INTEGER
 * STRING, never a JS number/float). Opens a directional position over the REAL atomic subscribe/mint
 * path; the owner receives BOTH legs of the paired package, `side` is the off-chain directional view.
 */
export const OpenPositionRequestSchema = z
  .object({
    coupledPairId: z
      .string()
      .uuid()
      .describe('The ACTIVE coupled pair the position is layered over.'),
    owner: EVM_ADDRESS.describe('Owner EVM address (holds both legs of the paired package).'),
    side: PositionSideSchema.describe('The recorded directional side (off-chain synthetic view).'),
    amount: POSITIVE_INTEGER_STRING.describe(
      'Position size in smallest units, a positive integer string (NFR-2).',
    ),
    paymentAsset: z.string().min(1).describe('Payment/collateral asset.'),
    idempotencyKey: z.string().min(1).describe('Idempotency key — exactly-once open (NFR-9).'),
  })
  .describe('A position-open request; the amount is a smallest-units string (NFR-2).');

/**
 * The body of `POST /positions/close` (whole-package / same-owner close over the redeem/burn path).
 * Refused with a 409 `SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` when the opposite leg is held by
 * another user (the §11.4 D1 topology — Story 8.6), BEFORE any burn is submitted.
 */
export const ClosePositionRequestSchema = z
  .object({
    positionId: z.string().uuid().describe('The OPEN position to close.'),
    paymentAsset: z.string().min(1).describe('Payment/collateral asset.'),
    idempotencyKey: z.string().min(1).describe('Idempotency key — exactly-once close (NFR-9).'),
  })
  .describe('A position-close request (whole-package / same-owner).');

/**
 * The persisted position embedded in an open/close flow view, once confirmed (null while pending —
 * no optimistic success). The lighter mirror of `PositionSchema` WITHOUT the live `mark` (the flow
 * view records the lifecycle, not the P&L listing). Money values are strings (NFR-2).
 */
export const FlowPositionSchema = z
  .object({
    id: z.string().uuid(),
    coupledPairId: z.string().uuid(),
    owner: z.string(),
    referenceAsset: z.string(),
    side: PositionSideSchema,
    sizeUnits: INTEGER_STRING.describe('Size/units — raw smallest-units string.'),
    entryPrice: DECIMAL_STRING.describe('Entry = anchor P₀ (decimal string).'),
    collateral: INTEGER_STRING.describe('Collateral — raw smallest-units string.'),
    leverage: DECIMAL_STRING.describe('Leverage (decimal string; pinned 1x in P0).'),
    realizedPnl: SIGNED_INTEGER_STRING.describe('Realized P&L — signed smallest-units string.'),
    lifecycle: PositionLifecycleSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe('The persisted position embedded in a flow view (no mark); money values are strings.');

/**
 * An open-position flow as returned by `POST /positions/open` and `GET /positions/open/:id`. It stays
 * `pending` (paired mint submitted on-chain, no journal entry, no position row) until the on-chain
 * commit point flips it to `confirmed` (carrying the posted `journalEntryId` and the created
 * `position`) — no optimistic success (UX-DR6). `amount` is a smallest-units integer string (NFR-2).
 */
export const OpenPositionViewSchema = z
  .object({
    id: z.string().describe('The idempotency key — the stable open-flow handle.'),
    coupledPairId: z.string(),
    owner: z.string(),
    side: PositionSideSchema,
    amount: INTEGER_STRING,
    paymentAsset: z.string(),
    status: PositionFlowStatusSchema,
    txHash: z.string().nullable(),
    journalEntryId: z.string().nullable(),
    position: FlowPositionSchema.nullable(),
  })
  .describe('A position-open flow; pending until the on-chain commit point, then confirmed.');

/**
 * A close-position flow as returned by `POST /positions/close` and `GET /positions/close/:id`. It
 * stays `pending` (paired burn submitted, position still OPEN) until the on-chain commit point flips
 * it to `confirmed` (the position closes) — no optimistic success. `amount` is a smallest-units string.
 */
export const ClosePositionViewSchema = z
  .object({
    id: z.string().describe('The idempotency key — the stable close-flow handle.'),
    positionId: z.string(),
    coupledPairId: z.string(),
    owner: z.string(),
    amount: INTEGER_STRING,
    paymentAsset: z.string(),
    status: PositionFlowStatusSchema,
    txHash: z.string().nullable(),
    journalEntryId: z.string().nullable(),
    position: FlowPositionSchema.nullable(),
  })
  .describe('A position-close flow; pending until the on-chain commit point, then confirmed.');

/** The inferred wire types of the position-flow views (the surface consumer's response types). */
export type OpenPositionViewResponse = z.infer<typeof OpenPositionViewSchema>;
export type ClosePositionViewResponse = z.infer<typeof ClosePositionViewSchema>;
export type FlowPositionResponse = z.infer<typeof FlowPositionSchema>;

/** A `:id` path parameter for a position-flow id (the idempotency key — a non-empty string). */
export const PositionFlowIdParamSchema = z.object({ id: z.string().min(1) });

// ─── Position ↔ pair reconciliation (operator — Story 8.5, FR-27) ───────────────────────────────

/** A per-(pair, side) residual-backing solvency row; amounts are exact integer strings (NFR-2). */
const SideBackingSchema = z.object({
  coupledPairId: z.string(),
  referenceAsset: z.string(),
  side: PositionSideSchema,
  backing: INTEGER_STRING.describe('Residual collateral backing of this side (its leg value).'),
  exposure: INTEGER_STRING.describe(
    'Aggregate off-chain exposure (Σ collateral of OPEN positions).',
  ),
  headroom: SIGNED_INTEGER_STRING.describe('backing − exposure (signed; negative ⇒ over-exposed).'),
  overExposed: z.boolean(),
  overExposedBy: INTEGER_STRING.describe('max(0, exposure − backing).'),
  openPositionCount: z.number().int().nonnegative(),
});

/** An over-exposed (pair, side), surfaced so cross-pair/cross-side headroom can never mask it. */
const OverExposedSideSchema = z.object({
  coupledPairId: z.string(),
  side: PositionSideSchema,
  overExposedBy: INTEGER_STRING,
});

/** A position↔pair mismatch and its correction outcome (surfaced — never silent). */
const PositionMismatchSchema = z.object({
  positionId: z.string(),
  coupledPairId: z.string(),
  owner: z.string(),
  side: PositionSideSchema,
  voidedCollateral: INTEGER_STRING,
  corrected: z.boolean(),
  correctable: z.boolean(),
  journalEntryId: z.string().nullable(),
  reason: z.string().nullable(),
});

/**
 * The full position↔pair reconciliation report returned by `POST /positions/reconcile` (FR-27). A
 * pure, JSON-serialisable report (NO bigint, NO float): the per-(pair, side) residual-backing
 * solvency (report-only) + any position↔pair mismatches. Called with NO chain-closed facts here, so
 * it is a read-only operator report (no correcting entries are posted).
 */
export const PositionReconciliationReportSchema = z
  .object({
    reconciledAt: z.string(),
    source: z.literal('positions+pairs+chain'),
    sideBacking: z.array(SideBackingSchema),
    overExposedSides: z.array(OverExposedSideSchema),
    anyOverExposure: z.boolean(),
    mismatches: z.array(PositionMismatchSchema),
    anyMismatch: z.boolean(),
    anyCorrected: z.boolean(),
    corrections: z.number().int().nonnegative(),
  })
  .describe(
    'The position↔pair reconciliation report (FR-27); amounts are integer strings (NFR-2).',
  );

/** The inferred wire type of the reconciliation report. */
export type PositionReconciliationReportResponse = z.infer<
  typeof PositionReconciliationReportSchema
>;

// ─── Coupled-pair strategy execution (write — Story 6.4, FR-20) ─────────────────────────────────

// A NON-negative smallest-units integer string (no sign) — a leg mark value may be 0 (total loss).
const NON_NEGATIVE_INTEGER_STRING = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer smallest-units string (no float, no sign)');

/** The leg side a reset attributes the loss to. */
export const LegSideSchema = z.enum(['long', 'short']);

/** A reset's lifecycle status (pending until commit, confirmed at the commit point, or failed). */
export const StrategyResetStatusSchema = z.enum(['pending', 'confirmed', 'failed']);

/**
 * The body of `POST /coupled-pairs/:id/strategy/ticks` (NFR-2: every monetary value crosses the wire
 * as a STRING). The coupled-pair id is the `:id` path param. The marked leg values are paper-supplied
 * inputs (`/prod` never derives them from price — the coupled-coin model is Epic 7); `price` is the
 * re-anchor target; `resetIdempotencyKey` makes a reset exactly-once (NFR-9).
 */
export const StrategyTickRequestSchema = z
  .object({
    price: DECIMAL_STRING.describe(
      'Observed reference price (decimal string) — the re-anchor target.',
    ),
    longLegMarkValue: NON_NEGATIVE_INTEGER_STRING.describe(
      'Marked value of the long leg, smallest-units string (paper-supplied input).',
    ),
    shortLegMarkValue: NON_NEGATIVE_INTEGER_STRING.describe(
      'Marked value of the short leg, smallest-units string (paper-supplied input).',
    ),
    paymentAsset: z.string().min(1).describe('Payment asset the reset crystallizes the P&L in.'),
    resetIdempotencyKey: z
      .string()
      .min(1)
      .describe('Idempotency key — exactly-once reset (NFR-9).'),
  })
  .describe(
    'A coupled-pair price tick; marks/price are strings (NFR-2). Threshold-only, never a clock.',
  );

/**
 * The outcome of feeding a tick: a strict no-op within the barrier, or a started reset on a floor
 * breach (pending until the on-chain commit point). `floorUnits` is the derived threshold (audit).
 */
export const StrategyTickOutcomeSchema = z
  .object({
    pairId: z.string(),
    action: z.enum(['none', 'reset-started']),
    reason: z.string(),
    losingLeg: LegSideSchema.nullable(),
    floorUnits: INTEGER_STRING.describe('The derived floor threshold in smallest-units (audit).'),
    state: CoupledPairStateSchema,
    txHash: z.string().nullable(),
    resetId: z.string().nullable(),
  })
  .describe('A strategy tick outcome; threshold-only — a within-barrier tick writes nothing.');

/**
 * A reset as returned by `GET /strategy/resets/:id`. It stays `pending` (burn submitted on-chain, no
 * journal entry) until the on-chain commit point flips it to `confirmed` (carrying the posted
 * `journalEntryId`) — no optimistic success.
 */
export const StrategyResetSchema = z
  .object({
    id: z.string().describe('The reset idempotency key — the stable reset handle.'),
    pairId: z.string(),
    status: StrategyResetStatusSchema,
    txHash: z.string().nullable(),
    journalEntryId: z.string().nullable(),
  })
  .describe(
    'A coupled-pair strategy reset; pending until the on-chain commit point, then confirmed.',
  );

/** A `:id` path parameter for a reset id (the idempotency key — a non-empty string, not a UUID). */
export const StrategyResetIdParamSchema = z.object({ id: z.string().min(1) });

// ─── Consolidated group view (read) ─────────────────────────────────────────────────────────────

const AccountBalanceSchema = z.object({
  accountId: z.string(),
  type: AccountTypeSchema,
  asset: z.string(),
  scale: z.number().int().nonnegative(),
  navRole: NavRoleSchema,
  normalSide: PostingDirectionSchema,
  totalDebit: MoneySchema,
  totalCredit: MoneySchema,
  net: MoneySchema,
});

const EntityAssetSubtotalSchema = z.object({
  asset: z.string(),
  scale: z.number().int().nonnegative(),
  assets: MoneySchema,
  liabilities: MoneySchema,
  equity: MoneySchema,
  nav: MoneySchema,
});

/** The four fixed entities' static operational roles (seeded in migration 0008). */
export const EntityRoleSchema = z.enum([
  'TREASURY_NOTE_ISSUER',
  'COORDINATION',
  'TRADING',
  'COIN_ISSUANCE',
]);

/** Per-entity reconciliation status derived from the group-level chain comparison. */
export const ReconciliationStatusSchema = z.enum(['RECONCILED', 'DIVERGENT', 'NOT_CHECKED']);

const EntitySchema = z.object({
  entityCode: EntityCodeSchema,
  jurisdiction: z.string(),
  role: EntityRoleSchema,
  reconciliationStatus: ReconciliationStatusSchema,
  accounts: z.array(AccountBalanceSchema),
  byAsset: z.array(EntityAssetSubtotalSchema),
});

/** A bright-line covenant kind (floor = stay ≥ threshold; ceiling = stay ≤ threshold). */
export const CovenantKindSchema = z.enum(['floor', 'ceiling']);

/** A covenant's live compliance status (NA when the denominator is unavailable). */
export const CovenantStatusSchema = z.enum(['PASS', 'WATCH', 'BREACH', 'NA']);

/** A single bright-line covenant; threshold + current value as integer basis points (1% = 100 bps). */
const CovenantSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: CovenantKindSchema,
  thresholdBps: z.number().int().nonnegative(),
  currentBps: z.number().int().nullable(),
  status: CovenantStatusSchema,
});

/** Net directional exposure for ONE market (never summed across unlike reference assets). */
const NetExposureSchema = z.object({
  referenceAsset: z.string(),
  pairCount: z.number().int().nonnegative(),
  longTotal: INTEGER_STRING,
  shortTotal: INTEGER_STRING,
  net: INTEGER_STRING,
});

/** One market row of the coupled-coin book (coupled pairs aggregated by reference asset). */
const CoupledCoinMarketSchema = z.object({
  referenceAsset: z.string(),
  pairs: z.number().int().nonnegative(),
  longNotional: INTEGER_STRING,
  shortNotional: INTEGER_STRING,
  collateral: INTEGER_STRING,
  net: INTEGER_STRING,
});

const ConsolidatedAssetSchema = z.object({
  asset: z.string(),
  scale: z.number().int().nonnegative(),
  assets: MoneySchema,
  liabilities: MoneySchema,
  equity: MoneySchema,
  nav: MoneySchema,
  balanced: z.boolean(),
});

const CoupledPairPositionSchema = z.object({
  id: z.string(),
  referenceAsset: z.string(),
  state: CoupledPairStateSchema,
  anchorPrice: DECIMAL_STRING,
  leverage: DECIMAL_STRING,
  floor: DECIMAL_STRING,
  longLegValue: INTEGER_STRING,
  shortLegValue: INTEGER_STRING,
  collateralPool: INTEGER_STRING,
  noteId: z.string().nullable(),
});

const DivergenceSchema = z.object({
  asset: z.string(),
  scale: z.number().int().nonnegative(),
  ledgerQuantity: MoneySchema,
  onChainTotalSupply: MoneySchema,
  divergence: MoneySchema,
  diverged: z.boolean(),
});

const ChainComparisonSchema = z.object({
  source: SourceSchema,
  divergences: z.array(DivergenceSchema),
  anyDivergence: z.boolean(),
});

/** The full consolidated group view returned by `GET /group-view` (FR-9). */
export const GroupViewSchema = z
  .object({
    generatedAt: z.string(),
    source: SourceSchema,
    entities: z.array(EntitySchema),
    consolidated: z.array(ConsolidatedAssetSchema),
    coupledPairs: z.array(CoupledPairPositionSchema),
    covenants: z.array(CovenantSchema),
    netExposure: z.array(NetExposureSchema),
    coupledCoinBook: z.array(CoupledCoinMarketSchema),
    chainComparison: ChainComparisonSchema,
    notes: z.array(z.string()),
  })
  .describe('The consolidated group view: per-entity balances, group NAV, pair positions (FR-9).');

/** The inferred wire type of the group view (the response serializer's input type). */
export type GroupViewResponse = z.infer<typeof GroupViewSchema>;

// ─── Health ─────────────────────────────────────────────────────────────────────────────────────

/** Liveness response. */
export const HealthSchema = z.object({ status: z.literal('ok') });

// ─── Structured error ───────────────────────────────────────────────────────────────────────────

/**
 * The boundary's structured error envelope (UX-DR5, NFR-4): a specific machine `code`, a
 * human-readable `message`, and optional structured `details`. Refusals are NEVER collapsed into a
 * generic error — the `code`/`message` name the refusing rule so the surface can show it to the user.
 */
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z
        .string()
        .describe('Specific machine code (e.g. AUTHORIZATION_DENIED, NotDeltaNeutralError).'),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .describe('Structured error: { error: { code, message, details? } }.');

// ─── Path params ─────────────────────────────────────────────────────────────────────────────────

/** A `:id` path parameter validated as a UUID (a malformed id ⇒ 400 at the boundary). */
export const IdParamSchema = z.object({ id: z.string().uuid() });
