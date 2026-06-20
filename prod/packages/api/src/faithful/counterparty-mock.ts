// MOCK counterparty/inventory adapter (Story 9.4, FR-31) — a CLEARLY-LABELLED DEMO STAND-IN that
// satisfies the §11.4 solvency-guardrail's resolution contract (`@rose/positions` `CounterpartyAdapter`)
// so the INDEPENDENT single-side close (the D1 topology — the opposite leg held by ANOTHER user)
// COMPLETES via RE-ASSIGNMENT in faithful mode, instead of the Story-8.6 fail-closed refusal. It models
// a HOUSE / inventory book taking over the exiting holder's side.
//
// WHAT IT DOES (one transaction, supplied by the caller):
//   1. flips the closing holder's position OPEN → CLOSED (terminal) — the opposite holder's leg is
//      NEVER touched, and NO on-chain `burnPair` is submitted (the package burns only when BOTH sides
//      are released);
//   2. has the HOUSE TAKE OVER the closer's SIDE by creating a house-owned OPEN position carrying the
//      SAME size/collateral — this CONSERVES the per-(pair, side) exposure, so the Story-8.5
//      residual-backing solvency invariant still holds after the move;
//   3. JOURNALS the claim transfer as ONE balanced, append-only, auditable double-entry (NFR-3, via the
//      `@rose/ledger` per-(asset, scale) balance trigger) against the caller-supplied account pair.
//
// CLEARLY-LABELLED SIMPLIFICATIONS (it is a MOCK, not the real model):
//   • The REAL board-gated §8 Q8 counterparty/inventory model (matched-book re-assignment vs a funded
//     house book, capital adequacy, fees, matching priority) is NOT resolved and stays DEFERRED. This
//     mock assumes an INFINITE, always-willing house at the closer's exact entry — no pricing, no
//     matching, no inventory limit, no P&L to the house.
//   • The "claim transfer" entry is a representative balanced move between two caller-supplied demo
//     accounts in ONE (asset, scale); it is auditable but is NOT the full settlement the real model
//     would post.
//   • PAPER/TESTNET ONLY: composed solely in faithful mode and NEVER on a real-capital path (NFR-4 /
//     §11.3). Absent the adapter, the close remains FAIL-CLOSED (Story 8.6 unchanged).
import { recordJournalEntry } from '@rose/ledger';
import {
  createPosition,
  closePosition as closePositionRow,
  type CounterpartyAdapter,
  type CounterpartyCloseResult,
  type CounterpartySingleSideCloseInput,
} from '@rose/positions';

/** The clearly-labelled HOUSE / inventory identity a mock-resolved single-side close re-assigns to. */
export const MOCK_HOUSE_OWNER = 'MOCK-HOUSE-INVENTORY';

/** Composition inputs for the mock counterparty/inventory adapter. */
export interface MockCounterpartyConfig {
  /** The house/inventory owner identity to re-assign the side to (defaults to {@link MOCK_HOUSE_OWNER}). */
  readonly houseOwner?: string;
  /**
   * The two demo accounts the balanced claim-transfer entry posts against. They MUST exist and share
   * the SAME (asset, scale) so the entry balances (the `@rose/ledger` trigger is the non-bypassable
   * backstop). The closer's collateral claim moves from `debitAccountId` to `creditAccountId`.
   */
  readonly claimTransfer: {
    readonly debitAccountId: string;
    readonly creditAccountId: string;
  };
}

/**
 * Builds the MOCK house-inventory counterparty adapter. Returns a frozen {@link CounterpartyAdapter}
 * whose `resolveSingleSideClose` re-assigns the closer's side to the house, conserves the per-side
 * collateral exposure, journals the move, and burns NOTHING. Compose ONLY in faithful mode.
 */
export function makeMockCounterpartyAdapter(config: MockCounterpartyConfig): CounterpartyAdapter {
  const houseOwner = config.houseOwner ?? MOCK_HOUSE_OWNER;
  const { debitAccountId, creditAccountId } = config.claimTransfer;

  return Object.freeze({
    async resolveSingleSideClose(
      input: CounterpartySingleSideCloseInput,
    ): Promise<CounterpartyCloseResult> {
      const { executor, position } = input;
      if (position.collateral <= 0n) {
        throw new Error(
          `mock counterparty: cannot re-assign position '${position.id}' with non-positive collateral.`,
        );
      }

      // 1. Flip the closer OPEN → CLOSED (terminal). The opposite holder's leg is NEVER touched, and no
      //    `burnPair` is submitted — the on-chain package burns only when BOTH sides are released.
      await closePositionRow(executor, position.id);

      // 2. The HOUSE TAKES OVER the closer's side carrying the SAME size/collateral. This CONSERVES the
      //    per-(pair, side) exposure so the Story-8.5 residual-backing invariant still holds afterwards.
      const housePosition = await createPosition(executor, {
        coupledPairId: position.coupledPairId,
        owner: houseOwner,
        referenceAsset: position.referenceAsset,
        side: position.side,
        sizeUnits: position.sizeUnits,
        entryPrice: position.entryPrice,
        collateral: position.collateral,
        leverage: '1',
      });

      // 3. JOURNAL the claim transfer — ONE balanced, append-only, auditable entry (NFR-3). NO burn.
      const entry = await recordJournalEntry(executor, {
        description:
          `MOCK counterparty (house inventory) — re-assigned ${position.side} single-side close of ` +
          `position ${position.id} (closer ${position.owner}) to ${houseOwner}; per-side backing ` +
          `conserved, on-chain package NOT burned (§8 Q8 model deferred — demo stand-in, FR-31)`,
        coupledPairId: position.coupledPairId,
        postings: [
          { accountId: debitAccountId, direction: 'DEBIT', amount: position.collateral },
          { accountId: creditAccountId, direction: 'CREDIT', amount: position.collateral },
        ],
      });

      console.info(
        '[faithful/counterparty-mock] re-assigned single-side close to house inventory',
        {
          coupledPairId: position.coupledPairId,
          side: position.side,
          closerPositionId: position.id,
          assignee: houseOwner,
          assigneePositionId: housePosition.id,
          journalEntryId: entry.entry.id,
          collateral: position.collateral.toString(),
        },
      );

      return {
        resolution: 'reassigned',
        closerPositionId: position.id,
        assignee: houseOwner,
        assigneePositionId: housePosition.id,
        journalEntryId: entry.entry.id,
      };
    },
  });
}
