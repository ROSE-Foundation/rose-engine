// FAITHFUL-MODE write-service composition (Story 9.1, FR-28). The production-faithful counterpart to
// `rose-note/src/paper/paper-mode.ts` + `api/src/paper-position-service.ts`: it composes the EXACT SAME
// inner write services (`makeSubscriptionService` / `makeRedemptionService` / `makeStrategyExecutor` /
// `makePositionService`) over the SAME `@rose/chain` paper transport, but replaces the INSTANT in-process
// auto-confirm with a DELAYED, failure-injectable confirmation driven through the
// `FaithfulConfirmationTransport`. The wrappers differ from paper ONLY in the confirm timing/failure
// (NFR-8/NFR-7): each freshly-submitted write reconstructs the SAME confirmed event the paper wrapper
// synthesizes (from the returned view, or — for strategy resets — from the SUBMITTED outbox intent) and
// hands it to the transport to schedule (or compensate), then returns its PENDING view unchanged.
//
// SCOPE (Story 9.1 only): authorization/eligibility/identity behave as in paper (a clearly-labelled
// faithful ALLOW + the FR-19 allowlist + the seeded identity) — the real default-deny + KYC (9.2),
// session identity (9.3), and counterparty mock (9.4) are out of scope and land later. Composed in
// `@rose/api` (not `@rose/rose-note`) for the same reason the paper position service is: `@rose/positions`
// already depends on `@rose/rose-note` + `@rose/chain`, so composing positions in `@rose/rose-note` would
// be an import cycle. SECURITY: in-process only — NO Sepolia, NO RPC, NO secret, NO real price feed.
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
import { findByIdempotencyKey, type RoseDb } from '@rose/ledger';
import {
  makeAllowlistEligibilityProvider,
  makeRedemptionService,
  makeStrategyExecutor,
  makeSubscriptionService,
  type PaperModeConfig,
  type PaperModeServices,
  type RedemptionService,
  type StrategyExecutor,
  type SubscriptionService,
} from '@rose/rose-note';
import {
  makePositionService,
  type ClosePositionInput,
  type ClosePositionView,
  type OpenPositionInput,
  type OpenPositionView,
  type PositionService,
} from '@rose/positions';
import { getAddress, type Address, type Hex } from 'viem';
import type { FaithfulConfirmationTransport } from './confirmation-transport.js';

/**
 * A concise, honest boot banner naming what is real vs mocked for the async-confirmation layer (the
 * always-visible UI banner is Story 9.6). Real: the ledger, the outbox/saga commit point + compensation.
 * Mocked: the chain transport's confirmation latency + injectable failure (testnet/paper, no real capital).
 */
export const FAITHFUL_MODE_BANNER =
  'FAITHFUL MODE — production-faithful demo (testnet/paper, NO real capital). REAL: ledger + ' +
  'outbox/saga commit-point & compensation. MOCKED: on-chain confirmation latency + injectable failure.';

/** Faithful authorization: a clearly-labelled ALLOW (9.2 will replace this with the real default-deny gate). */
const faithfulAuthorizeAllow = () =>
  ({
    effect: 'ALLOW',
    reason: 'faithful-mode: simulated authorization (real default-deny gate arrives in Story 9.2)',
  }) as const;

/**
 * Builds the faithful subscribe/redeem/strategy write services. Mirrors `makePaperModeServices` but
 * schedules each commit point through the `FaithfulConfirmationTransport` (delayed + failure-injectable)
 * instead of confirming instantly in-process. Returns the SAME `PaperModeServices` shape so the API
 * boundary composes it identically.
 */
export function makeFaithfulModeServices(
  config: PaperModeConfig,
  transport: FaithfulConfirmationTransport,
): PaperModeServices {
  const { db } = config;
  const pairAddress: Address = PAPER_PAIR_ADDRESS;
  const clients = createPaperChainClients();
  const account = makePaperAccount();
  const saga = new OutboxSaga({ db });
  const mint = new MintPairDualWrite({ saga, clients, account });
  const burn = new BurnPairDualWrite({ saga, clients, account });

  const innerSubscriptions = makeSubscriptionService({
    db,
    mint,
    pairAddress,
    eligibility: makeAllowlistEligibilityProvider(config.eligibleSubscribers),
    authorize: faithfulAuthorizeAllow,
    topology: config.subscriptionTopology,
    paymentAsset: config.paymentAsset,
  });

  const innerRedemptions = makeRedemptionService({
    db,
    burn,
    pairAddress,
    authorize: faithfulAuthorizeAllow,
    topology: config.redemptionTopology,
    paymentAsset: config.paymentAsset,
  });

  const innerStrategy = makeStrategyExecutor({
    db,
    burn,
    pairAddress,
    authorize: faithfulAuthorizeAllow,
    topology: config.strategyTopology,
    paymentAsset: config.paymentAsset,
    positionHolder: getAddress(config.positionHolder) as Address,
    floor: config.floor,
  });

  // A monotonic synthetic block height for the simulated events (audit only; the saga keys on tx hash).
  let syntheticBlock = 1_000n;
  const nextBlock = (): bigint => ++syntheticBlock;

  const subscriptions: SubscriptionService = {
    async subscribe(input) {
      const view = await innerSubscriptions.subscribe(input);
      // Schedule the DELAYED commit point. The synthetic PairMinted mirrors the recorded intent exactly
      // as the paper wrapper does (subscriber receives BOTH legs; on-chain amount == intent amount), so
      // the 5.3 divergence cross-checks pass at the (time-shifted) commit point. The returned view stays
      // PENDING (no optimistic success); a follow-up GET reads `pending` until the commit point, then
      // `confirmed` — or `failed` if a failure is injected.
      if (view.status === 'pending' && view.txHash !== null) {
        const txHash = view.txHash;
        const event: PairMintedEvent = {
          eventName: 'PairMinted',
          args: {
            lTo: getAddress(view.subscriber) as Address,
            sTo: getAddress(view.subscriber) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: txHash as Hex,
          logIndex: 0,
        };
        transport.scheduleConfirmation({
          txHash,
          confirm: async () => {
            await innerSubscriptions.confirm(event);
          },
        });
      }
      return view;
    },
    confirm: (event) => innerSubscriptions.confirm(event),
    getSubscription: (id) => innerSubscriptions.getSubscription(id),
  };

  const redemptions: RedemptionService = {
    async redeem(input) {
      const view = await innerRedemptions.redeem(input);
      if (view.status === 'pending' && view.txHash !== null) {
        const txHash = view.txHash;
        const event: PairBurnedEvent = {
          eventName: 'PairBurned',
          args: {
            lFrom: getAddress(view.redeemer) as Address,
            sFrom: getAddress(view.redeemer) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: txHash as Hex,
          logIndex: 0,
        };
        transport.scheduleConfirmation({
          txHash,
          confirm: async () => {
            await innerRedemptions.confirm(event);
          },
        });
      }
      return view;
    },
    confirm: (event) => innerRedemptions.confirm(event),
    getRedemption: (id) => innerRedemptions.getRedemption(id),
  };

  const strategy: StrategyExecutor = {
    async onTick(tick) {
      const outcome = await innerStrategy.onTick(tick);
      // Schedule the DELAYED reset commit point. The outcome carries no on-chain args, so — exactly as
      // the paper wrapper does — reconstruct the confirmed PairBurned from the recorded SUBMITTED outbox
      // intent (the holder legs + reset amount), guaranteeing the commit-point cross-checks pass.
      if (
        outcome.action === 'reset-started' &&
        outcome.resetId !== null &&
        outcome.txHash !== null
      ) {
        const row = await findByIdempotencyKey(db, outcome.resetId);
        if (row !== null && row.operationKind === 'PAIR_BURN' && row.status === 'SUBMITTED') {
          const payload = row.payload as Record<string, unknown>;
          const lFrom = payload.lFrom;
          const sFrom = payload.sFrom;
          const amount = payload.amount;
          if (
            typeof lFrom === 'string' &&
            typeof sFrom === 'string' &&
            typeof amount === 'string'
          ) {
            const txHash = outcome.txHash;
            const event: PairBurnedEvent = {
              eventName: 'PairBurned',
              args: {
                lFrom: getAddress(lFrom) as Address,
                sFrom: getAddress(sFrom) as Address,
                amount: BigInt(amount),
              },
              address: pairAddress,
              blockNumber: nextBlock(),
              transactionHash: txHash as Hex,
              logIndex: 0,
            };
            transport.scheduleConfirmation({
              txHash,
              confirm: async () => {
                await innerStrategy.confirmReset(event);
              },
            });
          }
        }
      }
      return outcome;
    },
    confirmReset: (event) => innerStrategy.confirmReset(event),
    getReset: (id) => innerStrategy.getReset(id),
  };

  return Object.freeze({ subscriptions, redemptions, strategy });
}

/** Composition inputs for the faithful position service — the resolved paper config + db + the transport. */
export interface MakeFaithfulPositionServiceInput {
  readonly db: RoseDb;
  readonly paperConfig: Omit<PaperModeConfig, 'db'>;
  readonly transport: FaithfulConfirmationTransport;
}

/**
 * Builds the faithful position service. Mirrors `makePaperPositionService` but schedules the open/close
 * commit point through the `FaithfulConfirmationTransport` (delayed + failure-injectable) instead of
 * confirming instantly. A `SolvencyGuardrailError` from `closePosition` (the D1 single-side topology) is
 * thrown BEFORE any burn submit, so it propagates untouched (the route maps it to a 409) and never
 * reaches the transport.
 */
export function makeFaithfulPositionService(
  input: MakeFaithfulPositionServiceInput,
): PositionService {
  const { db, paperConfig, transport } = input;
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
    authorize: faithfulAuthorizeAllow,
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
      if (view.status === 'pending' && view.txHash !== null) {
        const txHash = view.txHash;
        const event: PairMintedEvent = {
          eventName: 'PairMinted',
          args: {
            lTo: getAddress(view.owner) as Address,
            sTo: getAddress(view.owner) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: txHash as Hex,
          logIndex: 0,
        };
        transport.scheduleConfirmation({
          txHash,
          confirm: async () => {
            await inner.confirmOpen(event, { side: open.side });
          },
        });
      }
      return view;
    },

    confirmOpen: (event, ctx) => inner.confirmOpen(event, ctx),
    getOpenPosition: (id) => inner.getOpenPosition(id),

    async closePosition(close: ClosePositionInput): Promise<ClosePositionView> {
      // `closePosition` throws `SolvencyGuardrailError` (D1 single-side topology) BEFORE any burn is
      // submitted — let it propagate (the route maps it to a 409). Otherwise it returns PENDING with a
      // `txHash`; schedule the matching PairBurned commit point through the transport.
      const view = await inner.closePosition(close);
      if (view.status === 'pending' && view.txHash !== null) {
        const txHash = view.txHash;
        const event: PairBurnedEvent = {
          eventName: 'PairBurned',
          args: {
            lFrom: getAddress(view.owner) as Address,
            sFrom: getAddress(view.owner) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: txHash as Hex,
          logIndex: 0,
        };
        transport.scheduleConfirmation({
          txHash,
          confirm: async () => {
            await inner.confirmClose(event);
          },
        });
      }
      return view;
    },

    confirmClose: (event) => inner.confirmClose(event),
    getClosePosition: (id) => inner.getClosePosition(id),
  };
  return Object.freeze(service);
}
