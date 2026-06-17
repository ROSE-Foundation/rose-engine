// PAPER-MODE composition (infrastructure, NOT a BMAD story). Wires the EXACT seams the 6.2/6.3/6.4
// suites prove — the eligibility allowlist, the 5.3 paired-mint dual-write, the 5.4 paired-burn
// dual-write, all built on the `@rose/chain` paper transport — into ready-to-inject
// `SubscriptionService` / `RedemptionService` / `StrategyExecutor` ports, AND adds the one piece a
// shared live environment needs that the unit tests supply by hand: IN-PROCESS AUTO-CONFIRMATION.
//
// In the proven tests the commit point fires because the test synthesizes a confirmed
// `PairMinted`/`PairBurned` and calls `service.confirm(...)`. Here we promote that exact step into a
// thin wrapper: on a successful `subscribe` / `redeem` / breach `onTick` (which submits the on-chain
// tx and returns PENDING), we IMMEDIATELY synthesize the matching confirmed event — reconstructed from
// the recorded outbox intent so it can never diverge — and drive the SAME `confirmFrom...Event` commit
// point. The write therefore moves `pending → confirmed` (one balanced ledger entry) entirely in
// memory. The returned view is left PENDING on purpose (the lifecycle stays observable: the POST reads
// `pending`, a follow-up GET reads `confirmed`) — mirroring the real "no optimistic success" contract.
//
// SECURITY: paper only. NO Sepolia, NO RPC, NO secret, NO real price feed. The capital-flow
// authorization gate is a clearly-labelled paper ALLOW (the demo's real gate is the FR-19 eligibility
// allowlist); a real default-deny `postTransfer` provider is composed only on the live chain path.
import {
  BurnPairDualWrite,
  MintPairDualWrite,
  OutboxSaga,
  PAPER_MODE_BANNER,
  PAPER_PAIR_ADDRESS,
  createPaperChainClients,
  makePaperAccount,
  type PairBurnedEvent,
  type PairMintedEvent,
} from '@rose/chain';
import { findByIdempotencyKey, type RoseDb } from '@rose/ledger';
import { getAddress, type Address, type Hex } from 'viem';
import { makeAllowlistEligibilityProvider } from '../eligibility.js';
import { makeRedemptionService, type RedemptionService } from '../redeem.js';
import { makeStrategyExecutor, type StrategyExecutor } from '../strategy.js';
import { makeSubscriptionService, type SubscriptionService } from '../subscribe.js';
import type { RedemptionAccountTopology } from '../redemption-plan.js';
import type { StrategyResetTopology } from '../strategy-plan.js';
import type { SubscriptionAccountTopology } from '../subscription-plan.js';

/** Re-exported so a composition root can log the simulation banner without an `@rose/chain` edge. */
export { PAPER_MODE_BANNER };

/** The parked floor parameters the strategy threshold derives from (paper demo values, non-secret). */
export interface PaperFloorParams {
  readonly modelFloorM: string;
  readonly modelFloorG: string;
}

/** Composition inputs for the paper-mode write services. The caller (a composition root / seed) */
/** supplies the resolved ledger account topologies, the eligible subscriber allowlist, and the floor. */
export interface PaperModeConfig {
  readonly db: RoseDb;
  readonly subscriptionTopology: SubscriptionAccountTopology;
  readonly redemptionTopology: RedemptionAccountTopology;
  readonly strategyTopology: StrategyResetTopology;
  /** Allowlist-eligible subscriber addresses (the curated P0 audience analogue, FR-19). */
  readonly eligibleSubscribers: readonly string[];
  /** The single payment asset paper P0 supports (e.g. 'EUR'). */
  readonly paymentAsset: string;
  /** The holder whose paired legs a strategy reset retires (paper). */
  readonly positionHolder: string;
  /** The parked floor m/g the reset threshold derives from. */
  readonly floor: PaperFloorParams;
}

/** The three injected write ports a paper deployment composes into `ApiDeps`. */
export interface PaperModeServices {
  readonly subscriptions: SubscriptionService;
  readonly redemptions: RedemptionService;
  readonly strategy: StrategyExecutor;
}

/** Paper authorization: a clearly-labelled ALLOW (the demo's real gate is the eligibility allowlist). */
const paperAuthorizeAllow = () =>
  ({
    effect: 'ALLOW',
    reason: 'paper-mode: simulated authorization (no real chokepoint)',
  }) as const;

/**
 * Builds the auto-confirming paper write services. Composes the proven seams on the `@rose/chain`
 * paper transport, then wraps each service so a successful write also synthesizes its confirmed event
 * IN-PROCESS and drives the commit point — leaving the returned view PENDING so the lifecycle stays
 * observable. NO network, NO secret.
 */
export function makePaperModeServices(config: PaperModeConfig): PaperModeServices {
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
    authorize: paperAuthorizeAllow,
    topology: config.subscriptionTopology,
    paymentAsset: config.paymentAsset,
  });

  const innerRedemptions = makeRedemptionService({
    db,
    burn,
    pairAddress,
    authorize: paperAuthorizeAllow,
    topology: config.redemptionTopology,
    paymentAsset: config.paymentAsset,
  });

  const innerStrategy = makeStrategyExecutor({
    db,
    burn,
    pairAddress,
    authorize: paperAuthorizeAllow,
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
      // Auto-confirm a freshly-submitted subscription IN-PROCESS. The synthetic PairMinted mirrors the
      // recorded intent (subscriber receives BOTH legs; on-chain amount == intent amount) so the 5.3
      // divergence cross-checks pass and ONE balanced entry posts. confirm() never throws (contract).
      if (view.status === 'pending' && view.txHash !== null) {
        const event: PairMintedEvent = {
          eventName: 'PairMinted',
          args: {
            lTo: getAddress(view.subscriber) as Address,
            sTo: getAddress(view.subscriber) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: view.txHash as Hex,
          logIndex: 0,
        };
        await innerSubscriptions.confirm(event);
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
        const event: PairBurnedEvent = {
          eventName: 'PairBurned',
          args: {
            lFrom: getAddress(view.redeemer) as Address,
            sFrom: getAddress(view.redeemer) as Address,
            amount: view.amount,
          },
          address: pairAddress,
          blockNumber: nextBlock(),
          transactionHash: view.txHash as Hex,
          logIndex: 0,
        };
        await innerRedemptions.confirm(event);
      }
      return view;
    },
    confirm: (event) => innerRedemptions.confirm(event),
    getRedemption: (id) => innerRedemptions.getRedemption(id),
  };

  const strategy: StrategyExecutor = {
    async onTick(tick) {
      const outcome = await innerStrategy.onTick(tick);
      // Auto-confirm a freshly-submitted reset IN-PROCESS. The outcome carries no on-chain args, so we
      // reconstruct the confirmed PairBurned from the recorded SUBMITTED outbox intent (the holder legs
      // + reset amount) — guaranteeing the commit-point cross-checks pass and the pair re-bases.
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
            const event: PairBurnedEvent = {
              eventName: 'PairBurned',
              args: {
                lFrom: getAddress(lFrom) as Address,
                sFrom: getAddress(sFrom) as Address,
                amount: BigInt(amount),
              },
              address: pairAddress,
              blockNumber: nextBlock(),
              transactionHash: outcome.txHash as Hex,
              logIndex: 0,
            };
            await innerStrategy.confirmReset(event);
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
