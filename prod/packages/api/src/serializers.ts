// Boundary serializers (Story 6.1, NFR-2). Turn the ledger view objects — which carry `bigint`
// smallest-units and `Date` timestamps — into the plain, JSON-safe wire shapes the Zod response
// schemas validate. Every monetary VALUE becomes a STRING; a `bigint` is rendered as its exact
// smallest-units string (NEVER via a JS `number`/float), a `Date` as its ISO-8601 string. The
// consolidated group view is already a plain no-`bigint`/no-float object from `@rose/reconcile`, so
// it needs no re-serialization here.
import type { CoupledPairView, RoseNoteView } from '@rose/ledger';
import { assertNotFloat } from '@rose/shared';
import type { z } from 'zod/v4';
import type { CoupledPairSchema, RoseNoteSchema } from './schemas.js';

export type CoupledPairResponse = z.infer<typeof CoupledPairSchema>;
export type RoseNoteResponse = z.infer<typeof RoseNoteSchema>;

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
