// Consolidated group view (Story 5.5, FR-9). A READ-ONLY assembly of the off-chain ledger into
// per-entity, per-account-type balances + the consolidated group view (group NAV per asset), the
// coupled-pair positions, and (optionally) a read-only ledger↔chain divergence signal. It performs
// SELECTs only — it never writes, never corrects (correction is Story 5.6, D3/NFR-9).
//
// EXACT MONEY (NFR-2): every amount originates as an integer smallest-unit `bigint` (from
// `postings.amount` / `coupled_pairs` NUMERIC) and is formatted at the asset's decimal scale via
// `@rose/shared` `toDecimalString`. The JSON carries BOTH the raw smallest-unit integer string AND
// the formatted decimal string, so the text and JSON views derive from the ONE integer source.
// Binary float is never used.

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

/** One of the four fixed entities with its typed accounts and per-asset subtotals. */
export interface EntityView {
  readonly entityCode: EntityCode;
  readonly jurisdiction: string;
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

/** The full consolidated group view — a plain, JSON-serialisable object (NO bigint, NO float). */
export interface GroupView {
  readonly generatedAt: string;
  readonly source: 'ledger-only' | 'ledger+chain';
  readonly entities: ReadonlyArray<EntityView>;
  readonly consolidated: ReadonlyArray<ConsolidatedAssetView>;
  readonly coupledPairs: ReadonlyArray<CoupledPairPositionView>;
  readonly chainComparison: ChainComparisonView;
  /** Explicit, human-facing notes (e.g. the data source per D3). */
  readonly notes: ReadonlyArray<string>;
}

/** Options for `buildGroupView`. */
export interface BuildGroupViewOptions {
  /** When supplied, the view aggregates ledger + chain and emits the divergence signal (AC-2). */
  readonly chainSupplies?: ChainSupplySnapshot;
  /** Injected clock for a deterministic `generatedAt` (tests). Defaults to `new Date()`. */
  readonly now?: Date;
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
  return `${asset} ${scale}`;
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
 * the consolidated per-asset group NAV, and the coupled-pair positions. When `opts.chainSupplies`
 * is supplied it also emits a read-only divergence signal (ledger ASSET-side quantity vs on-chain
 * `totalSupply`) and labels the source `ledger+chain` (D3 — chain authoritative); it REPORTS
 * divergence and never corrects it (Story 5.6 owns the correcting entry). Returns a plain,
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

  // Per-entity assembly, in the fixed entity order.
  const entities: EntityView[] = [];
  for (const code of ENTITY_DISPLAY_ORDER) {
    const jurisdiction = jurisdictionByCode.get(code);
    if (jurisdiction === undefined) {
      // Entity not seeded (should never happen — migration 0001 seeds all four). Skip defensively.
      continue;
    }
    const entAggs = [...aggById.values()].filter((a) => a.entityCode === code);
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
      Object.freeze({ entityCode: code, jurisdiction, accounts: entAccounts, byAsset }),
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
  const consolidated: ConsolidatedAssetView[] = sortByDenom([...consMap.values()]).map((b) =>
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

  // Read-only chain divergence signal (D3 — REPORT only, never correct; 5.6 owns the correction).
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
  const chainComparison: ChainComparisonView = Object.freeze({
    source,
    divergences,
    anyDivergence: divergences.some((d) => d.diverged),
  });

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
