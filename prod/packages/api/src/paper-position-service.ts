// PAPER-MODE position-service composition (infrastructure, NOT a BMAD story). The Epic-8 secondary-
// trading position layer (`@rose/positions` `makePositionService`) exposed over HTTP in PAPER mode so
// participants can OPEN/CLOSE directional positions, watch live marks/P&L, hit the §11.4 solvency
// guardrail, and run position↔pair reconciliation — all IN-PROCESS, network-free, secret-free.
//
// This MUST be composed in `@rose/api` (not `@rose/rose-note`): `@rose/positions` already depends on
// `@rose/rose-note` and `@rose/chain`, so composing the paper position service inside `@rose/rose-note`
// would create an import cycle. `@rose/api` depends on both, so it is the correct composition root.
//
// It mirrors the EXACT auto-confirm pattern proven in `@rose/rose-note` `paper/paper-mode.ts`: each
// write submits the paired mint/burn (→ PENDING, returns a `txHash`), then we IMMEDIATELY synthesize
// the matching confirmed `PairMinted`/`PairBurned` event — reconstructed from the returned view so it
// can never diverge from the recorded intent — and drive the SAME commit point (`confirmOpen`/
// `confirmClose`). The returned view is left PENDING on purpose: the lifecycle stays observable (the
// POST reads `pending`, a follow-up GET reads `confirmed`). A `SolvencyGuardrailError` thrown by
// `closePosition` (the D1 single-side topology) propagates untouched — the route maps it to a 409.
//
// SECURITY: paper only. NO Sepolia, NO RPC, NO secret, NO real price feed. The capital-flow
// authorization gate is a clearly-labelled paper ALLOW (the demo's real gate is the FR-19 eligibility
// allowlist); a real default-deny gate is composed only on the live chain path.
import {
  BurnPairDualWrite,
  MintPairDualWrite,
  OutboxSaga,
  PAPER_PAIR_ADDRESS,
  createPaperChainClients,
  makePaperAccount,
  type PairBurnedEvent,
  type PairMintedEvent,
} from '@rose/chain';
import type { RoseDb } from '@rose/ledger';
import {
  makePositionService,
  type ClosePositionInput,
  type ClosePositionView,
  type OpenPositionInput,
  type OpenPositionView,
  type PositionService,
} from '@rose/positions';
import { makeAllowlistEligibilityProvider, type PaperModeConfig } from '@rose/rose-note';
import { getAddress, type Address, type Hex } from 'viem';

/** Paper authorization: a clearly-labelled ALLOW (the demo's real gate is the eligibility allowlist). */
const paperAuthorizeAllow = () =>
  ({
    effect: 'ALLOW',
    reason: 'paper-mode: simulated position authorization (no real chokepoint)',
  }) as const;

/** Composition inputs — the resolved paper config (minus `db`) from `seedPaperDemo` + the `db` handle. */
export interface MakePaperPositionServiceInput {
  readonly db: RoseDb;
  readonly paperConfig: Omit<PaperModeConfig, 'db'>;
}

/**
 * Builds the auto-confirming PAPER position service. Composes `@rose/positions` `makePositionService`
 * over the `@rose/chain` paper transport (a fresh outbox saga + paired mint/burn dual-writes, exactly
 * as `paper-mode.ts` does for subscribe/redeem), the FR-19 allowlist eligibility, a paper ALLOW
 * authorization gate, and the seeded subscription/redemption topologies. Wraps `openPosition`/
 * `closePosition` so a freshly-submitted write also synthesizes its confirmed event IN-PROCESS and
 * drives the commit point — leaving the returned view PENDING so the lifecycle stays observable.
 */
export function makePaperPositionService(input: MakePaperPositionServiceInput): PositionService {
  const { db, paperConfig } = input;
  const pairAddress: Address = PAPER_PAIR_ADDRESS;
  const clients = createPaperChainClients();
  const account = makePaperAccount();
  const saga = new OutboxSaga({ db });
  const mint = new MintPairDualWrite({ saga, clients, account });
  const burn = new BurnPairDualWrite({ saga, clients, account });

  const inner = makePositionService({
    db,
    saga,
    mint,
    burn,
    pairAddress,
    eligibility: makeAllowlistEligibilityProvider(paperConfig.eligibleSubscribers),
    authorize: paperAuthorizeAllow,
    openTopology: paperConfig.subscriptionTopology,
    closeTopology: paperConfig.redemptionTopology,
    paymentAsset: paperConfig.paymentAsset,
  });

  // A monotonic synthetic block height for the simulated events (audit only; the saga keys on tx hash).
  let syntheticBlock = 8_000n;
  const nextBlock = (): bigint => ++syntheticBlock;

  const service: PositionService = {
    async openPosition(open: OpenPositionInput): Promise<OpenPositionView> {
      const view = await inner.openPosition(open);
      // Auto-confirm a freshly-submitted open IN-PROCESS. The synthetic PairMinted mirrors the
      // recorded intent (owner holds BOTH legs; on-chain amount == intent amount), so the 5.3
      // divergence cross-checks pass and ONE balanced entry posts + the position is created. The
      // commit point (`confirmOpen`) never throws (contract). The PENDING view is returned unchanged.
      if (view.status === 'pending' && view.txHash !== null) {
        const event: PairMintedEvent = {
          eventName: 'PairMinted',
          args: {
            lTo: getAddress(view.owner) as Address,
            sTo: getAddress(view.owner) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: view.txHash as Hex,
          logIndex: 0,
        };
        await inner.confirmOpen(event, { side: open.side });
      }
      return view;
    },

    confirmOpen: (event, ctx) => inner.confirmOpen(event, ctx),
    getOpenPosition: (id) => inner.getOpenPosition(id),

    async closePosition(close: ClosePositionInput): Promise<ClosePositionView> {
      // `closePosition` throws `SolvencyGuardrailError` (D1 single-side topology) BEFORE any burn is
      // submitted — let it propagate (the route maps it to a 409). Otherwise it returns PENDING with a
      // `txHash`; auto-confirm the matching PairBurned IN-PROCESS to drive the OPEN→CLOSED commit point.
      const view = await inner.closePosition(close);
      if (view.status === 'pending' && view.txHash !== null) {
        const event: PairBurnedEvent = {
          eventName: 'PairBurned',
          args: {
            lFrom: getAddress(view.owner) as Address,
            sFrom: getAddress(view.owner) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: view.txHash as Hex,
          logIndex: 0,
        };
        await inner.confirmClose(event);
      }
      return view;
    },

    confirmClose: (event) => inner.confirmClose(event),
    getClosePosition: (id) => inner.getClosePosition(id),
  };
  return Object.freeze(service);
}
