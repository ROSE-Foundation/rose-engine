// Coupled-pair issuance (FR-13) — the OFF-CHAIN accounting record of bringing a coupled pair
// live. Issuing a pair records BOTH legs in ONE balanced journal entry linked to the pair
// (journal_entries.coupled_pair_id), in a SINGLE transaction, so issuance is atomic and is
// never recorded one leg at a time. The on-chain mint (FR-18) is Epic 5 — out of scope here.
//
// "A single-leg issuance is impossible" is enforced at four independent layers (defence in
// depth, each sufficient on its own):
//   1. Schema (Story 2.1): a coupled pair is one row with both leg values NOT NULL — a
//      persistent single-leg pair is structurally unrepresentable.
//   2. Explicit entry-level guard: each of longLeg/shortLeg must carry ≥1 posting.
//   3. Explicit pair-level guard: each leg value must be > 0 at issuance (an economically
//      empty leg is a single leg) — tightening Story 2.1's >= 0.
//   4. Ledger rules (Story 1.6/1.5): the combined entry must have ≥2 postings and balance per
//      (asset, scale); the DEFERRABLE double-entry DB trigger is the commit-time backstop.
//
// Because every step runs on one transaction, ANY rejection rolls back the whole issuance and
// persists nothing — no orphan pair, no half-recorded entry.
//
// The issuance postings are CALLER-SUPPLIED: the off-chain ledger does not yet model which
// account is "the long leg" (leg→token-account linkage arrives with Epic 5). This function does
// not derive postings from V_A/V_B and does not assert V_A + V_B = K (parked, D1). It guarantees
// only: ONE balanced entry, linked to the pair, with both legs present.
//
// P0 interpretation (epic 2.3 is silent on lifecycle): recording the issuance is the event that
// brings the pair live, so issuance advances PENDING → ACTIVE (Story 2.2) in the same
// transaction. The input omits `state` — issuance owns the lifecycle entry point.
import type { RoseDb } from '../db.js';
import {
  type CoupledPairView,
  type CreateCoupledPairInput,
  createCoupledPair,
  transitionPair,
} from './coupled-pairs.js';
import {
  type JournalEntryWithPostings,
  type RecordPostingInput,
  recordJournalEntry,
} from './journal-entries.js';

/** One leg of an issuance: the postings that record it. Must be non-empty (no single leg). */
export interface IssuanceLegInput {
  readonly postings: ReadonlyArray<RecordPostingInput>;
}

/**
 * Input for issuing a coupled pair off-chain. `pair` omits `state`: issuance always creates the
 * pair at PENDING and activates it. The single issuance journal entry is `description` plus the
 * concatenation of `longLeg` and `shortLeg` postings — it must balance per (asset, scale).
 */
export interface IssueCoupledPairInput {
  readonly pair: Omit<CreateCoupledPairInput, 'state'>;
  readonly description: string;
  readonly longLeg: IssuanceLegInput;
  readonly shortLeg: IssuanceLegInput;
}

/** Result of a successful issuance: the now-ACTIVE pair and the single balanced entry. */
export interface IssuedCoupledPair {
  readonly pair: CoupledPairView;
  readonly entry: JournalEntryWithPostings;
}

/** Thrown when an issuance would record only a single leg (missing postings or zero value). */
export class SingleLegIssuanceError extends Error {
  readonly leg: 'long' | 'short';
  readonly reason: 'no-postings' | 'non-positive-value';
  constructor(leg: 'long' | 'short', reason: 'no-postings' | 'non-positive-value') {
    const detail =
      reason === 'no-postings'
        ? `the ${leg} leg has no postings`
        : `the ${leg} leg value must be > 0`;
    super(
      `Cannot issue a single-leg coupled pair: ${detail}. Issuance records both legs together.`,
    );
    this.name = 'SingleLegIssuanceError';
    this.leg = leg;
    this.reason = reason;
  }
}

/**
 * Issues a coupled pair OFF-CHAIN as one balanced journal entry linked to the pair (FR-13). In a
 * SINGLE transaction: creates the pair (both legs, PENDING), records ONE balanced entry of both
 * legs' postings linked via `coupledPairId`, and activates the pair (PENDING → ACTIVE). Returns
 * the ACTIVE pair and the entry. Rejects a single-leg issuance — at the entry level (a leg with
 * no postings) and the pair level (a leg with value ≤ 0) — with `SingleLegIssuanceError`, and a
 * lone/unbalanced entry via the ledger's `InvalidJournalEntryError` / `UnbalancedEntryError`. Any
 * rejection rolls back the whole transaction, so nothing is persisted (no orphan pair).
 */
export async function issueCoupledPair(
  db: RoseDb,
  input: IssueCoupledPairInput,
): Promise<IssuedCoupledPair> {
  // Entry-level single-leg guard (no DB work): both legs must contribute postings.
  if (input.longLeg.postings.length === 0) {
    throw new SingleLegIssuanceError('long', 'no-postings');
  }
  if (input.shortLeg.postings.length === 0) {
    throw new SingleLegIssuanceError('short', 'no-postings');
  }

  return db.transaction(async (tx) => {
    // createCoupledPair validates the frozen field types (incl. bigint, non-negative leg values).
    const pair = await createCoupledPair(tx, { ...input.pair, state: 'PENDING' });

    // Pair-level single-leg guard: a zero-value leg is economically a single leg. Reading the
    // already-validated bigints off the view keeps this a pure bigint comparison (no float).
    if (pair.longLegValue <= 0n) {
      throw new SingleLegIssuanceError('long', 'non-positive-value');
    }
    if (pair.shortLegValue <= 0n) {
      throw new SingleLegIssuanceError('short', 'non-positive-value');
    }

    // ONE balanced entry capturing both legs, linked to the pair. recordJournalEntry enforces
    // ≥2 postings and per-(asset, scale) balance; a lone/unbalanced leg is rejected here.
    const entry = await recordJournalEntry(tx, {
      description: input.description,
      coupledPairId: pair.id,
      postings: [...input.longLeg.postings, ...input.shortLeg.postings],
    });

    // Issuance brings the pair live (documented P0 interpretation).
    const active = await transitionPair(tx, pair.id, 'ACTIVE');

    return { pair: active, entry };
  });
}
