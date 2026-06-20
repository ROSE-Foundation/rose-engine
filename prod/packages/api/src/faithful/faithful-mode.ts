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
// SCOPE: Story 9.1 (async confirmation) + 9.2 (default-deny + KYC) + 9.4 (the mock counterparty/
// inventory adapter resolving the D1 single-side close via house re-assignment). Session identity (9.3)
// and the operator panel/banner (9.5/9.6) land later. Composed in
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
import {
  makeKycAuthorizationGate,
  makeKycEligibilityProvider,
  runWithKycContext,
} from './faithful-authorization.js';
import { makeMockCounterpartyAdapter } from './counterparty-mock.js';
import type { MockKycRegistry } from './kyc-registry.js';

/**
 * The honest boot banner naming what is real vs mocked across the whole faithful composition (the
 * always-visible UI banner is Story 9.6, which derives the SAME real/mocked summary from the composed
 * deps via `deriveEngineMode`). Kept aligned with the FR-33 AC enumeration: REAL — ledger, deployed
 * contracts, the default-deny authorization gate, the §11.4 solvency guardrail + outbox/saga
 * compensation, position↔pair reconciliation; MOCKED — the chain transport confirmation latency +
 * injectable failure, the KYC/AML claim issuer, the counterparty/inventory model, the price feed.
 */
export const FAITHFUL_MODE_BANNER =
  'FAITHFUL MODE — production-faithful demo (testnet/paper, NO real capital; deployed contracts ' +
  'untouched). REAL: double-entry ledger + outbox/saga commit-point & compensation + the default-deny ' +
  'authorization gate + §11.4 solvency guardrail + position↔pair reconciliation. MOCKED: on-chain ' +
  'confirmation latency + injectable failure + KYC/AML claim issuer + counterparty/inventory (house) ' +
  'single-side-close re-assignment + reference-asset price feed.';

/**
 * Builds the faithful subscribe/redeem/strategy write services. Mirrors `makePaperModeServices` but
 * (1) schedules each commit point through the `FaithfulConfirmationTransport` (delayed + failure
 * -injectable, Story 9.1) instead of confirming instantly in-process, and (2) gates capital movement on
 * the REAL default-deny + KYC authorization (Story 9.2): the `authorize` gate + the FR-19 token-receipt
 * `EligibilityProvider` are BOTH derived from the injected `MockKycRegistry`, and each write runs inside
 * a KYC subject/operation context so the zero-arg gate decides on the right subject. Returns the SAME
 * `PaperModeServices` shape so the API boundary composes it identically.
 */
export function makeFaithfulModeServices(
  config: PaperModeConfig,
  transport: FaithfulConfirmationTransport,
  kycRegistry: MockKycRegistry,
): PaperModeServices {
  const { db } = config;
  const pairAddress: Address = PAPER_PAIR_ADDRESS;
  const clients = createPaperChainClients();
  const account = makePaperAccount();
  const saga = new OutboxSaga({ db });
  const mint = new MintPairDualWrite({ saga, clients, account });
  const burn = new BurnPairDualWrite({ saga, clients, account });
  // ONE KYC gate + ONE KYC-derived eligibility provider, shared across the write services (NFR-8).
  const authorize = makeKycAuthorizationGate(kycRegistry);
  const eligibility = makeKycEligibilityProvider(kycRegistry);
  const positionHolderAddress = getAddress(config.positionHolder) as Address;

  const innerSubscriptions = makeSubscriptionService({
    db,
    mint,
    pairAddress,
    eligibility,
    authorize,
    topology: config.subscriptionTopology,
    paymentAsset: config.paymentAsset,
  });

  const innerRedemptions = makeRedemptionService({
    db,
    burn,
    pairAddress,
    authorize,
    topology: config.redemptionTopology,
    paymentAsset: config.paymentAsset,
  });

  const innerStrategy = makeStrategyExecutor({
    db,
    burn,
    pairAddress,
    authorize,
    topology: config.strategyTopology,
    paymentAsset: config.paymentAsset,
    positionHolder: positionHolderAddress,
    floor: config.floor,
  });

  // A monotonic synthetic block height for the simulated events (audit only; the saga keys on tx hash).
  let syntheticBlock = 1_000n;
  const nextBlock = (): bigint => ++syntheticBlock;

  const subscriptions: SubscriptionService = {
    async subscribe(input) {
      // Capital-IN: gate receipt + authorization on the subscriber's KYC onboarding (default-deny).
      const view = await runWithKycContext({ subject: input.subscriber, capitalIn: true }, () =>
        innerSubscriptions.subscribe(input),
      );
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
      // Capital-OUT (exit): authorized regardless of onboarding (governed by lifecycle/§11.4, not KYC).
      const view = await runWithKycContext({ subject: input.redeemer, capitalIn: false }, () =>
        innerRedemptions.redeem(input),
      );
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
      // Capital-OUT (the reset retires the holder's paired legs): an exit, authorized regardless of KYC.
      const outcome = await runWithKycContext(
        { subject: positionHolderAddress, capitalIn: false },
        () => innerStrategy.onTick(tick),
      );
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
  /** The mock KYC registry the open authorization gate + token-receipt eligibility are derived from. */
  readonly kycRegistry: MockKycRegistry;
}

/**
 * Builds the faithful position service. Mirrors `makePaperPositionService` but (1) schedules the
 * open/close commit point through the `FaithfulConfirmationTransport` (delayed + failure-injectable)
 * instead of confirming instantly, and (2) composes the clearly-labelled MOCK counterparty/inventory
 * adapter (Story 9.4, FR-31) so a D1 INDEPENDENT single-side close RESOLVES via house re-assignment
 * instead of the Story-8.6 fail-closed refusal. The re-assignment commits synchronously (it submits NO
 * burn), so its `confirmed` view never reaches the transport. Paper mode injects NO adapter and stays
 * fail-closed (a `SolvencyGuardrailError` propagates to a 409).
 */
export function makeFaithfulPositionService(
  input: MakeFaithfulPositionServiceInput,
): PositionService {
  const { db, paperConfig, transport, kycRegistry } = input;
  const pairAddress: Address = PAPER_PAIR_ADDRESS;
  const clients = createPaperChainClients();
  const account = makePaperAccount();
  const saga = new OutboxSaga({ db });
  const mint = new MintPairDualWrite({ saga, clients, account });
  const burn = new BurnPairDualWrite({ saga, clients, account });

  // The MOCK house-inventory counterparty (Story 9.4): the claim-transfer entry posts against the
  // seeded EUR (scale 2) NOTE_LIABILITY → cash demo accounts (one (asset, scale) ⇒ it balances).
  const counterparty = makeMockCounterpartyAdapter({
    claimTransfer: {
      debitAccountId: paperConfig.redemptionTopology.noteLiabilityAccountId,
      creditAccountId: paperConfig.redemptionTopology.cashAccountId,
    },
  });

  const inner = makePositionService({
    db,
    saga,
    mint,
    burn,
    pairAddress,
    // The OPEN (mint receipt) eligibility + the capital-flow authorization gate, BOTH over the KYC registry.
    eligibility: makeKycEligibilityProvider(kycRegistry),
    authorize: makeKycAuthorizationGate(kycRegistry),
    openTopology: paperConfig.subscriptionTopology,
    closeTopology: paperConfig.redemptionTopology,
    paymentAsset: paperConfig.paymentAsset,
    // Story 9.4 / FR-31: the §11.4 guardrail's resolution port — present ONLY in faithful mode.
    counterparty,
  });

  // A monotonic synthetic block height for the simulated events (audit only; the saga keys on tx hash).
  let syntheticBlock = 8_000n;
  const nextBlock = (): bigint => ++syntheticBlock;

  const service: PositionService = {
    async openPosition(open: OpenPositionInput): Promise<OpenPositionView> {
      // Capital-IN: gate receipt + authorization on the owner's KYC onboarding (default-deny).
      const view = await runWithKycContext({ subject: open.owner, capitalIn: true }, () =>
        inner.openPosition(open),
      );
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
      // A D1 single-side close now RESOLVES through the mock counterparty (re-assignment) and returns a
      // `confirmed` view with a NULL txHash (no burn) — the `pending && txHash` guard below skips it, so
      // nothing is scheduled. A whole-package close still returns PENDING with a `txHash`; schedule its
      // matching PairBurned commit point through the transport. Capital-OUT (an exit): authorized
      // regardless of onboarding (governed by §11.4/lifecycle, not KYC).
      const view = await runWithKycContext({ capitalIn: false }, () => inner.closePosition(close));
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
