// The wire-contract types the surfaces consume — the SINGLE SOURCE is `@rose/api`'s Zod schemas
// (`import type` ⇒ fully erased under verbatimModuleSyntax: no runtime edge, no Fastify in the
// browser bundle). Nested shapes are reached by indexed access so nothing is redefined here.
import type {
  CoupledPairResponse,
  GroupViewResponse,
  PositionMarkResponse,
  PositionResponse,
  PositionsResponse,
  RedeemRequest,
  RedemptionResponse,
  RoseNoteResponse,
  SubscribeRequest,
  SubscriptionResponse,
} from '@rose/api';

export type {
  CoupledPairResponse,
  GroupViewResponse,
  PositionMarkResponse,
  PositionResponse,
  PositionsResponse,
  RedeemRequest,
  RedemptionResponse,
  RoseNoteResponse,
  SubscribeRequest,
  SubscriptionResponse,
};

/** A per-user position with its live mark (the Exchange-terminal row source, Story 8.4). */
export type Position = PositionResponse;

/** A position's live mark (status + directional P&L; trusted fields null unless OK). */
export type PositionMark = PositionMarkResponse;

/** The explicit mark state — OK renders a live mark/P&L; the rest are honest empty-states (UX-DR4). */
export type MarkStatus = PositionMarkResponse['status'];

/** A monetary amount over the wire (NFR-2): every value a string, `scale` metadata. */
export type Money = GroupViewResponse['consolidated'][number]['nav'];

/** A per-entity block in the group view (entity code, accounts, by-asset subtotals). */
export type GroupViewEntity = GroupViewResponse['entities'][number];

/** A single account balance row within an entity. */
export type AccountBalance = GroupViewEntity['accounts'][number];

/** A coupled-pair position as carried in the group view. */
export type CoupledPairPosition = GroupViewResponse['coupledPairs'][number];

/** The consolidated per-asset NAV subtotal. */
export type ConsolidatedAsset = GroupViewResponse['consolidated'][number];

/** The ledger↔chain comparison block (the divergence signal, FR-10). */
export type ChainComparison = GroupViewResponse['chainComparison'];

/** A single per-asset ledger↔chain divergence row. */
export type Divergence = ChainComparison['divergences'][number];

/** The six fixed coupled-pair lifecycle states (FR-4). */
export type CoupledPairState = CoupledPairPosition['state'];

/** The four fixed entity codes. */
export type EntityCode = GroupViewEntity['entityCode'];

/** A fixed entity's static operational role (FR-1). */
export type EntityRole = GroupViewEntity['role'];

/** Per-entity reconciliation status derived from the chain-comparison signal. */
export type ReconciliationStatus = GroupViewEntity['reconciliationStatus'];

/** A single bright-line covenant (threshold + current value as integer basis points). */
export type Covenant = GroupViewResponse['covenants'][number];

/** Net directional exposure across all coupled pairs. */
export type NetExposure = GroupViewResponse['netExposure'];

/** One market row of the coupled-coin book (coupled pairs aggregated by reference asset). */
export type CoupledCoinMarket = GroupViewResponse['coupledCoinBook'][number];

/** The fixed directional side of a position (LONG | SHORT) — reused from the position wire type. */
export type PositionSide = PositionResponse['side'];

/** A position's lifecycle state (OPEN | CLOSED) — reused from the position wire type. */
export type PositionLifecycle = PositionResponse['lifecycle'];

// ─── Position open/close + reconcile wire types (Stories 8.3/8.5/8.6, FR-25/FR-27) ──────────────
//
// These MIRROR the `@rose/api` Zod schemas (`OpenPositionRequestSchema`, `ClosePositionRequestSchema`,
// `OpenPositionViewSchema`, `ClosePositionViewSchema`, `PositionReconciliationReportSchema`) field for
// field. They are declared here rather than re-exported because the package root (`@rose/api`) does
// not re-export them; they MUST be kept in sync with those schemas (the single source of truth). Every
// money field is a string (NFR-2): decimal strings for genuinely-decimal values, raw smallest-unit
// integer strings for magnitudes, signed integer strings where a value may be negative.

/** A position open/close flow's lifecycle status — `pending` until the on-chain commit point. */
export type PositionFlowStatus = 'pending' | 'confirmed' | 'failed';

/** The body of `POST /positions/open` — `amount` is a smallest-units integer string (NFR-2). */
export interface OpenPositionRequest {
  coupledPairId: string;
  owner: string;
  side: PositionSide;
  amount: string;
  paymentAsset: string;
  idempotencyKey: string;
}

/** The body of `POST /positions/close` (whole-package / same-owner close over the burn path). */
export interface ClosePositionRequest {
  positionId: string;
  paymentAsset: string;
  idempotencyKey: string;
}

/** The persisted position embedded in a flow view once confirmed (no live `mark`; null while pending). */
export interface FlowPosition {
  id: string;
  coupledPairId: string;
  owner: string;
  referenceAsset: string;
  side: PositionSide;
  sizeUnits: string;
  entryPrice: string;
  collateral: string;
  leverage: string;
  realizedPnl: string;
  lifecycle: PositionLifecycle;
  createdAt: string;
  updatedAt: string;
}

/** `POST /positions/open` + `GET /positions/open/:id` — pending until the commit point, then confirmed. */
export interface OpenPositionView {
  id: string;
  coupledPairId: string;
  owner: string;
  side: PositionSide;
  amount: string;
  paymentAsset: string;
  status: PositionFlowStatus;
  txHash: string | null;
  journalEntryId: string | null;
  position: FlowPosition | null;
}

/** `POST /positions/close` + `GET /positions/close/:id` — pending until the commit point, then confirmed. */
export interface ClosePositionView {
  id: string;
  positionId: string;
  coupledPairId: string;
  owner: string;
  amount: string;
  paymentAsset: string;
  status: PositionFlowStatus;
  txHash: string | null;
  journalEntryId: string | null;
  position: FlowPosition | null;
}

/** A per-(pair, side) residual-backing solvency row (report-only); amounts are integer strings. */
export interface PositionSideBacking {
  coupledPairId: string;
  referenceAsset: string;
  side: PositionSide;
  backing: string;
  exposure: string;
  headroom: string;
  overExposed: boolean;
  overExposedBy: string;
  openPositionCount: number;
}

/** An over-exposed (pair, side), surfaced so cross-pair/cross-side headroom can never mask it. */
export interface OverExposedSide {
  coupledPairId: string;
  side: PositionSide;
  overExposedBy: string;
}

// ─── Simulation settings (paper-mode replay-feed parameters) ─────────────────────────────────────
//
// These MIRROR the `@rose/api` Zod schemas (`SimulationSettingsBoundsSchema`,
// `SimulationSettingsViewSchema`, `SimulationSettingsUpdateSchema`) field for field. They are declared
// here rather than re-exported because the package root (`@rose/api`) does not re-export them; they MUST
// be kept in sync with those schemas (the single source of truth). amplitude/periodSeconds are plain
// NUMBERS (simulation parameters, NOT money — no smallest-units string rule).

/** The inclusive validation bounds for the simulation settings (so the UI can build its controls). */
export interface SimulationSettingsBounds {
  amplitudeMin: number;
  amplitudeMax: number;
  periodSecondsMin: number;
  periodSecondsMax: number;
}

/** The core tunable replay-feed parameters: fractional price-swing amplitude + full cycle period. */
export interface SimulationSettings {
  amplitude: number;
  periodSeconds: number;
}

/** `GET /simulation/settings` + the body of `PUT /simulation/settings` — settings + version + bounds. */
export interface SimulationSettingsView extends SimulationSettings {
  version: number;
  bounds: SimulationSettingsBounds;
}

/** The body of `PUT /simulation/settings` — any subset of the tunable parameters. */
export interface SimulationSettingsUpdate {
  amplitude?: number;
  periodSeconds?: number;
}

/** A position↔pair mismatch and its correction outcome (surfaced — never silent). */
export interface PositionMismatch {
  positionId: string;
  coupledPairId: string;
  owner: string;
  side: PositionSide;
  voidedCollateral: string;
  corrected: boolean;
  correctable: boolean;
  journalEntryId: string | null;
  reason: string | null;
}

/** The full `POST /positions/reconcile` report (FR-27): residual-backing solvency + mismatches. */
export interface PositionReconciliationReport {
  reconciledAt: string;
  source: 'positions+pairs+chain';
  sideBacking: PositionSideBacking[];
  overExposedSides: OverExposedSide[];
  anyOverExposure: boolean;
  mismatches: PositionMismatch[];
  anyMismatch: boolean;
  anyCorrected: boolean;
  corrections: number;
}
