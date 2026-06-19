// Boundary serializers (Story 6.1, NFR-2). Turn the ledger view objects — which carry `bigint`
// smallest-units and `Date` timestamps — into the plain, JSON-safe wire shapes the Zod response
// schemas validate. Every monetary VALUE becomes a STRING; a `bigint` is rendered as its exact
// smallest-units string (NEVER via a JS `number`/float), a `Date` as its ISO-8601 string. The
// consolidated group view is already a plain no-`bigint`/no-float object from `@rose/reconcile`, so
// it needs no re-serialization here.
import type { CoupledPairView, RoseNoteView } from '@rose/ledger';
import type { PositionView } from '@rose/positions';
import type { Mark } from '@rose/price-oracle';
import { assertNotFloat } from '@rose/shared';
import type { z } from 'zod/v4';
import type {
  CoupledPairSchema,
  PositionSchema,
  PositionMarkSchema,
  RoseNoteSchema,
} from './schemas.js';

export type CoupledPairResponse = z.infer<typeof CoupledPairSchema>;
export type RoseNoteResponse = z.infer<typeof RoseNoteSchema>;
export type PositionResponse = z.infer<typeof PositionSchema>;
export type PositionMarkResponse = z.infer<typeof PositionMarkSchema>;

// A smallest-unit magnitude → exact integer string. `assertNotFloat` guards that a `bigint` (never a
// float) is what crosses the boundary (NFR-2).
function smallestUnits(amount: bigint): string {
  assertNotFloat(amount);
  return amount.toString();
}

/** Serialize a `CoupledPairView` to the wire shape: bigint→string, Date→ISO (NFR-2). */
export function serializeCoupledPair(view: CoupledPairView): CoupledPairResponse {
  return {
    id: view.id,
    referenceAsset: view.referenceAsset,
    anchorPrice: view.anchorPrice,
    leverage: view.leverage,
    collateralPool: smallestUnits(view.collateralPool),
    floor: view.floor,
    longLegValue: smallestUnits(view.longLegValue),
    shortLegValue: smallestUnits(view.shortLegValue),
    state: view.state,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

/** Serialize a `RoseNoteView` to the wire shape: Date→ISO. */
export function serializeRoseNote(view: RoseNoteView): RoseNoteResponse {
  return {
    id: view.id,
    coupledPairId: view.coupledPairId,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

/**
 * Serialize a position's 8.1 `Mark` to the wire shape (Story 8.4, FR-26). The trusted P&L is the
 * position's SIDE leg of the pair-level mark (LONG ⇒ `unrealizedPnl.long`, SHORT ⇒ `.short`); it is
 * `null` whenever the mark is not `OK` (NO_FEED/STALE/DIVERGENT — never fabricated). Prices/floor/
 * distance cross as decimal strings; the directional P&L crosses as a signed smallest-units integer
 * string (NFR-2); the provenance `asOf` Date → ISO.
 */
// A plain decimal string (mirrors the wire schema's `DECIMAL_STRING`).
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function serializeMark(mark: Mark, side: 'LONG' | 'SHORT'): PositionMarkResponse {
  const sideKey = side === 'LONG' ? 'long' : 'short';
  const directionalPnl = mark.unrealizedPnl === null ? null : mark.unrealizedPnl[sideKey];
  // On a contract-violating feed (`INVALID_PRICE`), `markToMarket` surfaces the raw figure as
  // `markPrice` and flags it. Null it out at the boundary if it is not a plain decimal string, so the
  // response ALWAYS validates (no 500 on a bad feed) — the integrity fault is still recorded in
  // `flags`, and a non-OK mark is never trusted anyway. Never a fabricated mark.
  const safeMarkPrice =
    mark.markPrice !== null && DECIMAL_RE.test(mark.markPrice) ? mark.markPrice : null;
  return {
    status: mark.status,
    entryPrice: mark.entryPrice,
    markPrice: safeMarkPrice,
    floor: mark.floor,
    distanceToFloor: mark.distanceToFloor,
    unrealizedPnl: directionalPnl === null ? null : smallestUnits(directionalPnl),
    floorBreached: mark.floorBreached,
    provenance:
      mark.provenance === null
        ? null
        : {
            source: mark.provenance.source,
            asOf: mark.provenance.asOf.toISOString(),
            ...(mark.provenance.sequence !== undefined
              ? { sequence: mark.provenance.sequence }
              : {}),
          },
    ageMs: mark.ageMs,
    freshnessBoundMs: mark.freshnessBoundMs,
    flags: [...mark.flags],
  };
}

/**
 * Build the explicit **"no price feed"** mark response (Story 8.4, UX-DR4) for when NO oracle is
 * composed. It is NOT routed through `markToMarket` (which requires the parked trust inputs) — saying
 * "there is no feed" needs no trust bound. Every trusted field is `null` (a mark is never fabricated);
 * `freshnessBoundMs` is `null` (no trust input was applied). The floor (a pair param) is still surfaced.
 */
export function noFeedMarkResponse(entryPrice: string, floor: string): PositionMarkResponse {
  return {
    status: 'NO_FEED',
    entryPrice,
    markPrice: null,
    floor,
    distanceToFloor: null,
    unrealizedPnl: null,
    floorBreached: null,
    provenance: null,
    ageMs: null,
    freshnessBoundMs: null,
    flags: ['NO_FEED'],
  };
}

/**
 * Serialize a `PositionView` + its already-serialized `mark` to the wire shape (Story 8.4, FR-26).
 * Smallest-unit magnitudes (size/collateral/realized P&L) → raw integer strings (the 6.1
 * no-fabricated-scale precedent — the positions row carries no per-token scale); entry/leverage →
 * decimal strings; Date → ISO. Every monetary value is a STRING (NFR-2).
 */
export function serializePosition(
  view: PositionView,
  mark: PositionMarkResponse,
): PositionResponse {
  return {
    id: view.id,
    coupledPairId: view.coupledPairId,
    owner: view.owner,
    referenceAsset: view.referenceAsset,
    side: view.side,
    sizeUnits: smallestUnits(view.sizeUnits),
    entryPrice: view.entryPrice,
    collateral: smallestUnits(view.collateral),
    leverage: view.leverage,
    realizedPnl: smallestUnits(view.realizedPnl),
    lifecycle: view.lifecycle,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    mark,
  };
}
