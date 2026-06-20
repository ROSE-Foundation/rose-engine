// Consolidated group view (Story 5.5, FR-9; Treasury Dashboard enrichment). A READ-ONLY assembly of
// the off-chain ledger into per-entity, per-account-type balances + the consolidated group view
// (group NAV per asset), the coupled-pair positions, the covenant monitor, net directional exposure,
// the coupled-coin book, and (optionally) a read-only ledger↔chain divergence signal. It performs
// SELECTs only — it never writes, never corrects (correction is Story 5.6, D3/NFR-9).
//
// EXACT MONEY (NFR-2): every amount originates as an integer smallest-unit `bigint` (from
// `postings.amount` / `coupled_pairs` NUMERIC) and is formatted at the asset's decimal scale via
// `@rose/shared` `toDecimalString`. The JSON carries BOTH the raw smallest-unit integer string AND
// the formatted decimal string, so the text and JSON views derive from the ONE integer source.
// Binary float is never used. Covenant ratios are exposed as integer BASIS POINTS (1% = 100 bps),
// computed by exact bigint division — never a binary float.

import { assertNotFloat, toDecimalString } from '@rose/shared';
import {
  accounts as accountsTable,
  coupledPairs as coupledPairsTable,
  entities as entitiesTable,
  postings as postingsTable,
  roseNotes as roseNotesTable,
  type AccountType,
  type CoupledPairState,
  type EntityCode,
  type EntityRole,
  type PostingDirection,
  type RoseDb,
} from '@rose/ledger';
import type { ChainSupplySnapshot } from './chain-supply.js';

/** The role an account type plays in NAV — the one documented P0 classification. */
export type NavRole = 'ASSET' | 'LIABILITY' | 'EQUITY';

/**
 * Account NAV classification — the SINGLE documented P0 interpretation (epics/PRD name "group NAV"
 * but do not enumerate each type's accounting sign). Kept as ONE frozen, reviewable map (mirroring
 * `ENTITY_ALLOWED_ACCOUNT_TYPES`): `normalSide` is the side on which the account's balance is
 * positive; `navRole` is its place in the accounting identity. NAV per asset = Σ ASSET − Σ LIABILITY
 * (= total EQUITY by construction). This is a PRESENTATION classification only — it changes no
 * ledger data. Refine when product specifies.
 */
export const ACCOUNT_NAV_CLASSIFICATION: Readonly<
  Record<AccountType, { readonly normalSide: PostingDirection; readonly navRole: NavRole }>
> = Object.freeze({
  BACKING_FLOAT: { normalSide: 'DEBIT', navRole: 'ASSET' },
  DEPLOYED_CAPITAL: { normalSide: 'DEBIT', navRole: 'ASSET' },
  CLIENT_COLLATERAL: { normalSide: 'CREDIT', navRole: 'LIABILITY' },
  FEE_INCOME: { normalSide: 'CREDIT', navRole: 'EQUITY' },
  NOTE_LIABILITY: { normalSide: 'CREDIT', navRole: 'LIABILITY' },
});

/** The four fixed entities, in their canonical display order (VCC = NAV anchor first). */
export const ENTITY_DISPLAY_ORDER: readonly EntityCode[] = Object.freeze([
  'VCC',
  'HOLDING',
  'TRADING_CO',
  'COIN_ISSUER',
] as const);

/** The five fixed account types, in their canonical display order. */
const ACCOUNT_TYPE_ORDER: readonly AccountType[] = Object.freeze([
  'BACKING_FLOAT',
  'DEPLOYED_CAPITAL',
  'CLIENT_COLLATERAL',
  'FEE_INCOME',
  'NOTE_LIABILITY',
] as const);

/** A money amount carried as BOTH its raw integer smallest-units AND its exact decimal string. */
export interface MoneyView {
  readonly asset: string;
  readonly scale: number;
  readonly smallestUnits: string;
  readonly decimal: string;
}

/** A single account's balance: debit/credit totals + the normal-side signed net. */
export interface AccountBalanceView {
  readonly accountId: string;
  readonly type: AccountType;
  readonly asset: string;
  readonly scale: number;
  readonly navRole: NavRole;
  readonly normalSide: PostingDirection;
  readonly totalDebit: MoneyView;
  readonly totalCredit: MoneyView;
  /** Net balance in the account's normal-side sign (DEBIT-normal ⇒ debit−credit; else credit−debit). */
  readonly net: MoneyView;
}

/** Per-entity, per-asset subtotal: assets / liabilities / equity and the resulting NAV. */
export interface EntityAssetSubtotal {
  readonly asset: string;
  readonly scale: number;
  readonly assets: MoneyView;
  readonly liabilities: MoneyView;
  readonly equity: MoneyView;
  readonly nav: MoneyView;
}

/** Per-entity reconciliation status, derived from the group-level chain-comparison signal. */
export type ReconciliationStatus = 'RECONCILED' | 'DIVERGENT' | 'NOT_CHECKED';

/** One of the four fixed entities with its typed accounts and per-asset subtotals. */
export interface EntityView {
  readonly entityCode: EntityCode;
  readonly jurisdiction: string;
  /** The entity's static operational role (FR-1; seeded in migration 0008). */
  readonly role: EntityRole;
  /**
   * Reconciliation status derived per entity from the chain comparison: `NOT_CHECKED` when no chain
   * snapshot was supplied; `DIVERGENT` only when THIS entity holds an account in a diverged
   * (asset, scale); else `RECONCILED`. (Divergence magnitudes remain group/asset-level in
   * `chainComparison`; this is the per-entity projection used by the cross-entity table.)
   */
  readonly reconciliationStatus: ReconciliationStatus;
  readonly accounts: ReadonlyArray<AccountBalanceView>;
  readonly byAsset: ReadonlyArray<EntityAssetSubtotal>;
}

/** Consolidated (group-wide) per-asset view: assets / liabilities / equity / NAV + balance check. */
export interface ConsolidatedAssetView {
  readonly asset: string;
  readonly scale: number;
  readonly assets: MoneyView;
  readonly liabilities: MoneyView;
  readonly equity: MoneyView;
  /** Group NAV for this asset = assets − liabilities (equals total equity by the double-entry identity). */
  readonly nav: MoneyView;
  /** True when Σ(debit−credit) over all accounts of this asset is exactly zero (double-entry holds). */
  readonly balanced: boolean;
}

/** A coupled-pair position surfaced in the group view (FR-6 magnitudes as raw smallest-unit strings). */
export interface CoupledPairPositionView {
  readonly id: string;
  readonly referenceAsset: string;
  readonly state: CoupledPairState;
  readonly anchorPrice: string;
  readonly leverage: string;
  readonly floor: string;
  /** V_A — long leg value, raw integer smallest-units (no fabricated scale). */
  readonly longLegValue: string;
  /** V_B — short leg value, raw integer smallest-units. */
  readonly shortLegValue: string;
  /** K — collateral pool, raw integer smallest-units. */
  readonly collateralPool: string;
  /** The embedding rose-note id, or null if the pair is not embedded in a note. */
  readonly noteId: string | null;
}

/** A read-only ledger↔chain divergence for one token asset (REPORTED, never corrected — 5.6 corrects). */
export interface DivergenceView {
  readonly asset: string;
  readonly scale: number;
  /** Σ over ASSET-classified accounts of this asset of (debit−credit) — the ledger circulating quantity. */
  readonly ledgerQuantity: MoneyView;
  readonly onChainTotalSupply: MoneyView;
  /** onChainTotalSupply − ledgerQuantity (signed; chain authoritative, D3). */
  readonly divergence: MoneyView;
  readonly diverged: boolean;
}

/** The chain-comparison block: the data source and the per-token divergence signals. */
export interface ChainComparisonView {
  readonly source: 'ledger-only' | 'ledger+chain';
  readonly divergences: ReadonlyArray<DivergenceView>;
  readonly anyDivergence: boolean;
}

/** A bright-line covenant kind: a `floor` (current must stay ≥ threshold) or a `ceiling` (≤). */
export type CovenantKind = 'floor' | 'ceiling';

/** A covenant's live compliance status. `NA` when the denominator is unavailable (e.g. NAV = 0). */
export type CovenantStatus = 'PASS' | 'WATCH' | 'BREACH' | 'NA';

/**
 * A single bright-line covenant computed against the dominant consolidated denomination. Threshold
 * and current value are exposed as integer BASIS POINTS (1% = 100 bps) so no binary float crosses
 * the wire. The covenant DEFINITIONS (which ratio each one is) are a documented P0 policy map,
 * revisable by product — they change no ledger data, mirroring `ACCOUNT_NAV_CLASSIFICATION`.
 */
export interface CovenantView {
  readonly key: string;
  readonly label: string;
  readonly kind: CovenantKind;
  readonly thresholdBps: number;
  /** The live ratio in bps, or null when the denominator is ≤ 0 (cannot be computed honestly). */
  readonly currentBps: number | null;
  readonly status: CovenantStatus;
}

/**
 * Net directional exposure for ONE market (reference asset). Delta-neutral by construction ⇒ net ≈ 0.
 * Totals are summed only WITHIN a reference asset — coupled-pair leg values are raw integer "units"
 * with no recorded scale, so summing across unlike reference assets would mix denominations. There is
 * deliberately NO group-wide net scalar.
 */
export interface NetExposureView {
  readonly referenceAsset: string;
  readonly pairCount: number;
  /** Σ long-leg values for this market, raw integer "units" string. */
  readonly longTotal: string;
  /** Σ short-leg values for this market, raw integer "units" string. */
  readonly shortTotal: string;
  /** longTotal − shortTotal (signed), raw integer "units" string. */
  readonly net: string;
}

/** One market row of the coupled-coin book: coupled pairs aggregated by reference asset. */
export interface CoupledCoinMarketView {
  readonly referenceAsset: string;
  readonly pairs: number;
  readonly longNotional: string;
  readonly shortNotional: string;
  readonly collateral: string;
  readonly net: string;
}

/** Bright-line covenant thresholds as RATIO decimal strings (e.g. '0.60' = 60%). */
export interface CovenantThresholds {
  readonly backingFloatFloor: string;
  readonly clientCollateralRatio: string;
  readonly deployCeiling: string;
}

/** The full consolidated group view — a plain, JSON-serialisable object (NO bigint, NO float). */
export interface GroupView {
  readonly generatedAt: string;
  readonly source: 'ledger-only' | 'ledger+chain';
  readonly entities: ReadonlyArray<EntityView>;
  readonly consolidated: ReadonlyArray<ConsolidatedAssetView>;
  readonly coupledPairs: ReadonlyArray<CoupledPairPositionView>;
  /** The bright-line covenant monitor (empty when no thresholds were injected). */
  readonly covenants: ReadonlyArray<CovenantView>;
  /** Net directional exposure, one entry per market (never summed across unlike reference assets). */
  readonly netExposure: ReadonlyArray<NetExposureView>;
  /** Coupled pairs aggregated into a per-market book. */
  readonly coupledCoinBook: ReadonlyArray<CoupledCoinMarketView>;
  readonly chainComparison: ChainComparisonView;
  /** Explicit, human-facing notes (e.g. the data source per D3). */
  readonly notes: ReadonlyArray<string>;
}

/** Options for `buildGroupView`. */
export interface BuildGroupViewOptions {
  /** When supplied, the view aggregates ledger + chain and emits the divergence signal (AC-2). */
  readonly chainSupplies?: ChainSupplySnapshot;
  /**
   * When supplied, the view computes the covenant monitor against the dominant consolidated
   * denomination. Injected by the API composition root from `@rose/config` (refuse-if-absent) —
   * `@rose/reconcile` never reads env, mirroring the `chainSupplies` injection.
   */
  readonly covenantThresholds?: CovenantThresholds;
  /**
   * Faithful-mode operator override (Story 9.5, FR-32): when true, the covenant monitor genuinely
   * reports a BREACH on the backing-float-floor covenant by computing the LIVE backing ratio against a
   * documented stress floor threshold (`FORCE_BREACH_FLOOR_THRESHOLD`) through the real
   * `covenantStatus` path — not a cosmetic label (`currentBps` stays a real ledger ratio). The ratio's
   * denominator is the dominant asset's gross balance-sheet FOOTING (assets + liabilities), a
   * GUARANTEED-POSITIVE quantity, so the forced row is a genuine BREACH (never NA) EVEN when group NAV
   * is 0/degenerate — the seeded faithful demo has assets ≈ liabilities ⇒ NAV ≈ 0, which a NAV
   * denominator would read as NA. Self-contained: a BREACH row is emitted even when no
   * `covenantThresholds` are configured. Cleared by the operator (consulted per request). Inert in
   * `paper`/read-only (never set).
   */
  readonly forceCovenantBreach?: boolean;
  /** Injected clock for a deterministic `generatedAt` (tests). Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * The stress floor threshold the Story-9.5 covenant-breach injection computes the backing-float-floor
 * covenant against: a 1,000,000% backing requirement no finite positive live ratio can satisfy, so
 * `covenantStatus` genuinely derives BREACH from the real `currentBps`. The forced row uses the gross
 * balance-sheet footing (assets + liabilities) as its denominator, which is positive whenever any
 * balance exists, so the BREACH holds even when group NAV is 0 (assets ≈ liabilities) — see
 * `forcedBreachFloorCovenant`.
 */
export const FORCE_BREACH_FLOOR_THRESHOLD = '1000000';

/**
 * Build the Story-9.5 operator force-breach backing-float-floor covenant: a GENUINE BREACH derived
 * through the real `covenantStatus`, computed against a guaranteed-positive denominator — the dominant
 * asset's gross balance-sheet FOOTING (assets + liabilities) — so it breaches even when group NAV is
 * 0/degenerate (the seeded faithful demo has assets ≈ liabilities ⇒ NAV ≈ 0, which a NAV denominator
 * reads as NA). `currentBps` stays the REAL backing/footing ratio; a degenerate empty footing reads as
 * 0 backing against an impossible floor. Either way the floor is BREACH by construction (never NA).
 */
function forcedBreachFloorCovenant(backing: bigint, footing: bigint): CovenantView {
  const thresholdBps = ratioToBps(FORCE_BREACH_FLOOR_THRESHOLD);
  const currentBps = footing > 0n ? Number((backing * 10000n) / footing) : 0;
  return Object.freeze({
    key: 'backing-float-floor',
    label: 'Backing-float floor',
    kind: 'floor' as const,
    thresholdBps,
    currentBps,
    status: covenantStatus('floor', currentBps, thresholdBps),
  });
}

// Parse a NUMERIC string to a bigint, rejecting a real fractional part — the established
// smallest-units read contract (mirrors `@rose/ledger` journal-entries `numericToBigInt`).
function numericToBigInt(value: string): bigint {
  const [intPart = '0', fracPart] = value.split('.');
  if (fracPart !== undefined && /[^0]/.test(fracPart)) {
    throw new Error(
      `Non-integer amount '${value}' read from ledger (smallest-units contract, NFR-2).`,
    );
  }
  return BigInt(intPart);
}

// Format a bigint smallest-unit amount as a MoneyView (raw integer string + exact decimal string).
function moneyView(asset: string, scale: number, amount: bigint): MoneyView {
  assertNotFloat(amount);
  return Object.freeze({
    asset,
    scale,
    smallestUnits: amount.toString(),
    decimal: toDecimalString({ asset, scale, amount }),
  });
}

// Parse a ratio decimal string (e.g. '0.60', '1.00', '0.35') to integer basis points (1% = 100 bps,
// so 100% = 10000 bps). Exact: no binary float — fractional digits beyond 4 are truncated.
function ratioToBps(ratio: string): number {
  const negative = ratio.startsWith('-');
  const [intPart = '0', fracPart = ''] = ratio.replace('-', '').split('.');
  const frac4 = (fracPart + '0000').slice(0, 4);
  const bps = BigInt(intPart) * 10000n + BigInt(frac4);
  return Number(negative ? -bps : bps);
}

// Compute one covenant: current ratio (in bps) = numerator/denominator via exact bigint division;
// null when the denominator is ≤ 0 (cannot honestly compute a ratio). Status compares against the
// threshold with a 5%-of-threshold WATCH band on the safe side of the limit.
function computeCovenant(
  key: string,
  label: string,
  kind: CovenantKind,
  numerator: bigint,
  denominator: bigint,
  thresholdRatio: string,
): CovenantView {
  const thresholdBps = ratioToBps(thresholdRatio);
  // A negative denominator (e.g. insolvent NAV < 0) cannot yield an honest ratio: a `floor` can never
  // be satisfied ⇒ BREACH; a `ceiling` is undefined ⇒ NA. A zero denominator is genuinely NA.
  if (denominator < 0n) {
    return Object.freeze({
      key,
      label,
      kind,
      thresholdBps,
      currentBps: null,
      status: kind === 'floor' ? 'BREACH' : 'NA',
    });
  }
  const currentBps = denominator === 0n ? null : Number((numerator * 10000n) / denominator);
  const status = covenantStatus(kind, currentBps, thresholdBps);
  return Object.freeze({ key, label, kind, thresholdBps, currentBps, status });
}

function covenantStatus(
  kind: CovenantKind,
  currentBps: number | null,
  thresholdBps: number,
): CovenantStatus {
  if (currentBps === null) return 'NA';
  // 5% of the threshold — the WATCH margin. `currentBps` is bigint floor-division (truncates toward
  // zero), so a floor reads conservatively; `Math.max(1, …)` keeps the band from collapsing to 0 for
  // very small thresholds (which would make WATCH unreachable).
  const band = Math.max(1, Math.round(thresholdBps * 0.05));
  if (kind === 'floor') {
    if (currentBps < thresholdBps) return 'BREACH';
    if (currentBps < thresholdBps + band) return 'WATCH';
    return 'PASS';
  }
  // ceiling
  if (currentBps > thresholdBps) return 'BREACH';
  if (currentBps > thresholdBps - band) return 'WATCH';
  return 'PASS';
}

// A per-account aggregation accumulator.
interface AccountAgg {
  readonly accountId: string;
  readonly entityCode: EntityCode;
  readonly type: AccountType;
  readonly asset: string;
  readonly scale: number;
  debit: bigint;
  credit: bigint;
}

// The ledger's denomination is the (asset, decimal_scale) pair — the double-entry trigger balances
// per (asset, scale), so the same asset label at two scales is two DISTINCT denominations whose
// smallest-units must never be summed together. The group view keys every subtotal on this pair.
function denomKey(asset: string, scale: number): string {
  return `${asset} ${scale}`;
}

function sortByDenom<T extends { asset: string; scale: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : a.scale - b.scale,
  );
}

/**
 * Builds the consolidated group view (FR-9) by reading the off-chain ledger. STRICTLY READ-ONLY:
 * SELECTs entities/accounts/postings/coupled_pairs/rose_notes, aggregates per-account balances in
 * `bigint`, and assembles per-entity → per-account-type balances, per-entity per-asset subtotals,
 * the consolidated per-asset group NAV, the coupled-pair positions, the covenant monitor (when
 * thresholds are injected), net directional exposure, and the coupled-coin book. When
 * `opts.chainSupplies` is supplied it also emits a read-only divergence signal (ledger ASSET-side
 * quantity vs on-chain `totalSupply`) and labels the source `ledger+chain` (D3 — chain authoritative);
 * it REPORTS divergence and never corrects it (Story 5.6 owns the correcting entry). Returns a plain,
 * JSON-serialisable `GroupView` (no `bigint`, no float).
 */
export async function buildGroupView(
  db: RoseDb,
  opts: BuildGroupViewOptions = {},
): Promise<GroupView> {
  const entityRows = await db.select().from(entitiesTable);
  const accountRows = await db.select().from(accountsTable);
  const postingRows = await db.select().from(postingsTable);
  const pairRows = await db.select().from(coupledPairsTable);
  const noteRows = await db.select().from(roseNotesTable);

  const entityCodeById = new Map<string, EntityCode>(entityRows.map((e) => [e.id, e.code]));
  const jurisdictionByCode = new Map<EntityCode, string>(
    entityRows.map((e) => [e.code, e.jurisdiction]),
  );
  const roleByCode = new Map<EntityCode, EntityRole>(entityRows.map((e) => [e.code, e.role]));

  // Per-account aggregation seeded from the account rows (so zero-activity accounts still appear).
  const aggById = new Map<string, AccountAgg>();
  for (const a of accountRows) {
    const entityCode = entityCodeById.get(a.entityId);
    if (entityCode === undefined) {
      throw new Error(`Account '${a.id}' references unknown entity '${a.entityId}'.`);
    }
    aggById.set(a.id, {
      accountId: a.id,
      entityCode,
      type: a.type,
      asset: a.asset,
      scale: a.decimalScale,
      debit: 0n,
      credit: 0n,
    });
  }
  for (const p of postingRows) {
    const agg = aggById.get(p.accountId);
    if (agg === undefined) {
      throw new Error(`Posting '${p.id}' references unknown account '${p.accountId}'.`);
    }
    const amount = numericToBigInt(p.amount);
    if (p.direction === 'DEBIT') agg.debit += amount;
    else agg.credit += amount;
  }

  // Build per-account balance views, signed in the account's normal side.
  const accountViewsById = new Map<string, AccountBalanceView>();
  for (const agg of aggById.values()) {
    const { normalSide, navRole } = ACCOUNT_NAV_CLASSIFICATION[agg.type];
    const net = normalSide === 'DEBIT' ? agg.debit - agg.credit : agg.credit - agg.debit;
    accountViewsById.set(
      agg.accountId,
      Object.freeze({
        accountId: agg.accountId,
        type: agg.type,
        asset: agg.asset,
        scale: agg.scale,
        navRole,
        normalSide,
        totalDebit: moneyView(agg.asset, agg.scale, agg.debit),
        totalCredit: moneyView(agg.asset, agg.scale, agg.credit),
        net: moneyView(agg.asset, agg.scale, net),
      }),
    );
  }

  // Read-only chain divergence signal (D3 — REPORT only, never correct; 5.6 owns the correction).
  // Computed before the per-entity assembly so each entity can carry the derived reconciliation status.
  const source: 'ledger-only' | 'ledger+chain' = opts.chainSupplies
    ? 'ledger+chain'
    : 'ledger-only';
  const divergences: DivergenceView[] = [];
  if (opts.chainSupplies) {
    for (const token of opts.chainSupplies.tokens) {
      // Ledger circulating quantity = Σ over ASSET-classified accounts of this (asset, scale)
      // denomination of (debit−credit). Scale is matched so a same-label token at another scale is
      // a different denomination (consistent with the ledger's per-(asset,scale) balance unit).
      let ledgerQuantity = 0n;
      for (const agg of aggById.values()) {
        if (agg.asset !== token.asset || agg.scale !== token.scale) continue;
        if (ACCOUNT_NAV_CLASSIFICATION[agg.type].navRole !== 'ASSET') continue;
        ledgerQuantity += agg.debit - agg.credit;
      }
      const divergence = token.totalSupply - ledgerQuantity;
      divergences.push(
        Object.freeze({
          asset: token.asset,
          scale: token.scale,
          ledgerQuantity: moneyView(token.asset, token.scale, ledgerQuantity),
          onChainTotalSupply: moneyView(token.asset, token.scale, token.totalSupply),
          divergence: moneyView(token.asset, token.scale, divergence),
          diverged: divergence !== 0n,
        }),
      );
    }
  }
  const anyDivergence = divergences.some((d) => d.diverged);
  const chainComparison: ChainComparisonView = Object.freeze({
    source,
    divergences,
    anyDivergence,
  });
  // Denominations that actually diverged — used to derive each entity's status HONESTLY (an entity is
  // DIVERGENT only if it holds an account in a diverged (asset, scale), not because the group did).
  const divergedDenoms = new Set(
    divergences.filter((d) => d.diverged).map((d) => denomKey(d.asset, d.scale)),
  );

  // Per-entity assembly, in the fixed entity order.
  const entities: EntityView[] = [];
  for (const code of ENTITY_DISPLAY_ORDER) {
    const jurisdiction = jurisdictionByCode.get(code);
    const role = roleByCode.get(code);
    if (jurisdiction === undefined || role === undefined) {
      // Entity not seeded (should never happen — migrations 0001/0008 seed all four). Skip defensively.
      continue;
    }
    const entAggs = [...aggById.values()].filter((a) => a.entityCode === code);
    // Honest per-entity reconciliation: DIVERGENT only if this entity holds an account in a diverged
    // (asset, scale); RECONCILED when checked-and-clean; NOT_CHECKED when no chain snapshot.
    const entReconciliationStatus: ReconciliationStatus =
      source === 'ledger-only'
        ? 'NOT_CHECKED'
        : entAggs.some((a) => divergedDenoms.has(denomKey(a.asset, a.scale)))
          ? 'DIVERGENT'
          : 'RECONCILED';
    const entAccounts = entAggs
      .map((a) => accountViewsById.get(a.accountId)!)
      .sort((x, y) => {
        const t = ACCOUNT_TYPE_ORDER.indexOf(x.type) - ACCOUNT_TYPE_ORDER.indexOf(y.type);
        return t !== 0 ? t : x.asset < y.asset ? -1 : x.asset > y.asset ? 1 : 0;
      });

    // Per-asset subtotal for this entity.
    const byAssetMap = new Map<
      string,
      { asset: string; scale: number; assets: bigint; liabilities: bigint; equity: bigint }
    >();
    for (const agg of entAggs) {
      const v = accountViewsById.get(agg.accountId)!;
      const key = denomKey(agg.asset, agg.scale);
      const bucket = byAssetMap.get(key) ?? {
        asset: agg.asset,
        scale: agg.scale,
        assets: 0n,
        liabilities: 0n,
        equity: 0n,
      };
      const netUnits = BigInt(v.net.smallestUnits);
      if (v.navRole === 'ASSET') bucket.assets += netUnits;
      else if (v.navRole === 'LIABILITY') bucket.liabilities += netUnits;
      else bucket.equity += netUnits;
      byAssetMap.set(key, bucket);
    }
    const byAsset: EntityAssetSubtotal[] = sortByDenom([...byAssetMap.values()]).map((b) =>
      Object.freeze({
        asset: b.asset,
        scale: b.scale,
        assets: moneyView(b.asset, b.scale, b.assets),
        liabilities: moneyView(b.asset, b.scale, b.liabilities),
        equity: moneyView(b.asset, b.scale, b.equity),
        nav: moneyView(b.asset, b.scale, b.assets - b.liabilities),
      }),
    );

    entities.push(
      Object.freeze({
        entityCode: code,
        jurisdiction,
        role,
        reconciliationStatus: entReconciliationStatus,
        accounts: entAccounts,
        byAsset,
      }),
    );
  }

  // Consolidated per-asset view across ALL entities + the double-entry balance check.
  const consMap = new Map<
    string,
    {
      asset: string;
      scale: number;
      assets: bigint;
      liabilities: bigint;
      equity: bigint;
      signedSum: bigint;
    }
  >();
  for (const agg of aggById.values()) {
    const v = accountViewsById.get(agg.accountId)!;
    const key = denomKey(agg.asset, agg.scale);
    const bucket = consMap.get(key) ?? {
      asset: agg.asset,
      scale: agg.scale,
      assets: 0n,
      liabilities: 0n,
      equity: 0n,
      signedSum: 0n,
    };
    const netUnits = BigInt(v.net.smallestUnits);
    if (v.navRole === 'ASSET') bucket.assets += netUnits;
    else if (v.navRole === 'LIABILITY') bucket.liabilities += netUnits;
    else bucket.equity += netUnits;
    // Double-entry identity: debits == credits per (asset, scale) — the trigger's balance unit.
    bucket.signedSum += agg.debit - agg.credit;
    consMap.set(key, bucket);
  }
  const consolidatedBuckets = sortByDenom([...consMap.values()]);
  const consolidated: ConsolidatedAssetView[] = consolidatedBuckets.map((b) =>
    Object.freeze({
      asset: b.asset,
      scale: b.scale,
      assets: moneyView(b.asset, b.scale, b.assets),
      liabilities: moneyView(b.asset, b.scale, b.liabilities),
      equity: moneyView(b.asset, b.scale, b.equity),
      nav: moneyView(b.asset, b.scale, b.assets - b.liabilities),
      balanced: b.signedSum === 0n,
    }),
  );

  // Covenant monitor — computed against the DOMINANT consolidated denomination, chosen by LARGEST NAV
  // magnitude (not alphabetical), so covenants anchor on the economically dominant asset, not a
  // trivial one. Only when thresholds are injected.
  const covenants: CovenantView[] = [];
  const navMagnitude = (b: { assets: bigint; liabilities: bigint }): bigint => {
    const nav = b.assets - b.liabilities;
    return nav < 0n ? -nav : nav;
  };
  const dominant = consolidatedBuckets.reduce<(typeof consolidatedBuckets)[number] | undefined>(
    (best, b) => (best === undefined || navMagnitude(b) > navMagnitude(best) ? b : best),
    undefined,
  );
  // Compute the monitor when thresholds are configured OR the Story-9.5 breach injection is active
  // (the injection is self-contained — it emits a genuine BREACH row even with no configured monitor).
  if ((opts.covenantThresholds || opts.forceCovenantBreach) && dominant !== undefined) {
    let backing = 0n;
    let deployed = 0n;
    let clientLiability = 0n;
    for (const agg of aggById.values()) {
      if (agg.asset !== dominant.asset || agg.scale !== dominant.scale) continue;
      const v = accountViewsById.get(agg.accountId)!;
      const net = BigInt(v.net.smallestUnits);
      if (agg.type === 'BACKING_FLOAT') backing += net;
      else if (agg.type === 'DEPLOYED_CAPITAL') deployed += net;
      else if (agg.type === 'CLIENT_COLLATERAL') clientLiability += net;
    }
    const nav = dominant.assets - dominant.liabilities;
    const th = opts.covenantThresholds;
    // The backing-float-floor row: when the operator breach injection is active it is a GENUINE BREACH
    // computed against a guaranteed-positive footing (so it breaches even at NAV ≈ 0 — see
    // `forcedBreachFloorCovenant`); otherwise it is the configured floor computed against NAV.
    if (opts.forceCovenantBreach) {
      covenants.push(forcedBreachFloorCovenant(backing, dominant.assets + dominant.liabilities));
    } else if (th?.backingFloatFloor !== undefined) {
      covenants.push(
        computeCovenant(
          'backing-float-floor',
          'Backing-float floor',
          'floor',
          backing,
          nav,
          th.backingFloatFloor,
        ),
      );
    }
    if (th) {
      covenants.push(
        computeCovenant(
          'deploy-ratio-ceiling',
          'Deploy ratio (ceiling)',
          'ceiling',
          deployed,
          nav,
          th.deployCeiling,
        ),
        // Client-collateral coverage: group assets must cover client claims ≥ 100% (clients always made
        // whole). Honestly computed from existing classifications (NO segregated-asset sub-ledger exists).
        computeCovenant(
          'client-collateral-coverage',
          'Client-collateral coverage',
          'floor',
          dominant.assets,
          clientLiability,
          th.clientCollateralRatio,
        ),
      );
    }
  }

  // Coupled-pair positions + note embedding.
  const noteIdByPairId = new Map<string, string>(noteRows.map((n) => [n.coupledPairId, n.id]));
  const coupledPairs: CoupledPairPositionView[] = [...pairRows]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((p) =>
      Object.freeze({
        id: p.id,
        referenceAsset: p.referenceAsset,
        state: p.state,
        anchorPrice: p.anchorPrice,
        leverage: p.leverage,
        floor: p.floor,
        longLegValue: numericToBigInt(p.longLegValue).toString(),
        shortLegValue: numericToBigInt(p.shortLegValue).toString(),
        collateralPool: numericToBigInt(p.collateralPool).toString(),
        noteId: noteIdByPairId.get(p.id) ?? null,
      }),
    );

  // Coupled-coin book — coupled pairs aggregated by reference asset (one row per market).
  const bookMap = new Map<
    string,
    { referenceAsset: string; pairs: number; long: bigint; short: bigint; collateral: bigint }
  >();
  for (const p of coupledPairs) {
    const bucket = bookMap.get(p.referenceAsset) ?? {
      referenceAsset: p.referenceAsset,
      pairs: 0,
      long: 0n,
      short: 0n,
      collateral: 0n,
    };
    bucket.pairs += 1;
    bucket.long += BigInt(p.longLegValue);
    bucket.short += BigInt(p.shortLegValue);
    bucket.collateral += BigInt(p.collateralPool);
    bookMap.set(p.referenceAsset, bucket);
  }
  const coupledCoinBook: CoupledCoinMarketView[] = [...bookMap.values()]
    .sort((a, b) =>
      a.referenceAsset < b.referenceAsset ? -1 : a.referenceAsset > b.referenceAsset ? 1 : 0,
    )
    .map((b) =>
      Object.freeze({
        referenceAsset: b.referenceAsset,
        pairs: b.pairs,
        longNotional: b.long.toString(),
        shortNotional: b.short.toString(),
        collateral: b.collateral.toString(),
        net: (b.long - b.short).toString(),
      }),
    );

  // Net directional exposure, PER market (projection of the book — never summed across markets, whose
  // "units" are unlike). Delta-neutral by construction ⇒ each market's net ≈ 0.
  const netExposure: NetExposureView[] = coupledCoinBook.map((m) =>
    Object.freeze({
      referenceAsset: m.referenceAsset,
      pairCount: m.pairs,
      longTotal: m.longNotional,
      shortTotal: m.shortNotional,
      net: m.net,
    }),
  );

  const notes: string[] = [
    source === 'ledger+chain'
      ? 'Source: off-chain ledger aggregated with on-chain token supplies; the chain is authoritative for token quantities (D3). Divergences are reported only — correction toward the chain is Story 5.6.'
      : 'Source: off-chain ledger only. No on-chain supply snapshot was supplied, so no ledger↔chain divergence check was performed.',
  ];

  const generatedAt = (opts.now ?? new Date()).toISOString();

  return Object.freeze({
    generatedAt,
    source,
    entities,
    consolidated,
    coupledPairs,
    covenants,
    netExposure,
    coupledCoinBook,
    chainComparison,
    notes,
  });
}

/** Returns the group view as a plain object ready for `JSON.stringify` (it already contains no bigint). */
export function groupViewToJson(view: GroupView): GroupView {
  return view;
}

/** Serialises the group view to a JSON string (pretty-printed). No bigint, no float (NFR-2). */
export function serializeGroupView(view: GroupView, space: number = 2): string {
  return JSON.stringify(view, null, space);
}
