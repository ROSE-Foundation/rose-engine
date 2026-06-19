// Typed fixtures shaped to the `@rose/api` contract (the surfaces consume the SAME wire types in
// test as at runtime — only the transport differs: a fixture-backed client here, the paper/local
// API at runtime). NO network, NO secret.
import type {
  CoupledPairResponse,
  GroupViewEntity,
  GroupViewResponse,
  Money,
  Position,
  PositionMark,
  PositionsResponse,
  RedemptionResponse,
  RoseNoteResponse,
  SubscriptionResponse,
} from '../lib/contract-types.js';

export function money(asset: string, scale: number, smallestUnits: string, decimal: string): Money {
  return { asset, scale, smallestUnits, decimal };
}

const eur = (units: string, decimal: string): Money => money('EUR', 2, units, decimal);

const vcc: GroupViewEntity = {
  entityCode: 'VCC',
  jurisdiction: 'LU',
  role: 'TREASURY_NOTE_ISSUER',
  reconciliationStatus: 'RECONCILED',
  accounts: [
    {
      accountId: 'vcc-backing-float',
      type: 'BACKING_FLOAT',
      asset: 'EUR',
      scale: 2,
      navRole: 'ASSET',
      normalSide: 'DEBIT',
      totalDebit: eur('1248033000', '12480330.00'),
      totalCredit: eur('0', '0.00'),
      net: eur('1248033000', '12480330.00'),
    },
    {
      accountId: 'vcc-note-liability',
      type: 'NOTE_LIABILITY',
      asset: 'EUR',
      scale: 2,
      navRole: 'LIABILITY',
      normalSide: 'CREDIT',
      totalDebit: eur('0', '0.00'),
      totalCredit: eur('1000000000', '10000000.00'),
      net: eur('1000000000', '10000000.00'),
    },
  ],
  byAsset: [
    {
      asset: 'EUR',
      scale: 2,
      assets: eur('1248033000', '12480330.00'),
      liabilities: eur('1000000000', '10000000.00'),
      equity: eur('248033000', '2480330.00'),
      nav: eur('248033000', '2480330.00'),
    },
  ],
};

const tradingCo: GroupViewEntity = {
  entityCode: 'TRADING_CO',
  jurisdiction: 'KY',
  role: 'TRADING',
  reconciliationStatus: 'RECONCILED',
  accounts: [
    {
      accountId: 'tco-fee-income',
      type: 'FEE_INCOME',
      asset: 'EUR',
      scale: 2,
      navRole: 'EQUITY',
      normalSide: 'CREDIT',
      totalDebit: eur('0', '0.00'),
      totalCredit: eur('50000', '500.00'),
      net: eur('50000', '500.00'),
    },
  ],
  byAsset: [
    {
      asset: 'EUR',
      scale: 2,
      assets: eur('0', '0.00'),
      liabilities: eur('0', '0.00'),
      equity: eur('50000', '500.00'),
      nav: eur('50000', '500.00'),
    },
  ],
};

const activePairPosition = {
  id: 'pair-1',
  referenceAsset: 'BTC',
  state: 'ACTIVE' as const,
  anchorPrice: '60000.00',
  leverage: '3',
  floor: '0.6',
  longLegValue: '10000',
  shortLegValue: '10000',
  collateralPool: '20000',
  noteId: 'note-1',
};

/** A populated, reconciled group view (no divergence). */
export function reconciledGroupView(): GroupViewResponse {
  return {
    generatedAt: '2026-06-16T12:00:00.000Z',
    source: 'ledger+chain',
    entities: [vcc, tradingCo],
    consolidated: [
      {
        asset: 'EUR',
        scale: 2,
        assets: eur('1248033000', '12480330.00'),
        liabilities: eur('1000000000', '10000000.00'),
        equity: eur('248083000', '2480830.00'),
        nav: eur('1248033000', '12480330.00'),
        balanced: true,
      },
    ],
    coupledPairs: [activePairPosition],
    covenants: [
      {
        key: 'backing-float-floor',
        label: 'Backing-float floor',
        kind: 'floor',
        thresholdBps: 6000,
        currentBps: 6670,
        status: 'PASS',
      },
      {
        key: 'deploy-ratio-ceiling',
        label: 'Deploy ratio (ceiling)',
        kind: 'ceiling',
        thresholdBps: 3500,
        currentBps: 1800,
        status: 'PASS',
      },
      {
        key: 'client-collateral-coverage',
        label: 'Client-collateral coverage',
        kind: 'floor',
        thresholdBps: 10000,
        currentBps: 10000,
        status: 'PASS',
      },
    ],
    netExposure: [
      { referenceAsset: 'BTC', pairCount: 1, longTotal: '10000', shortTotal: '10000', net: '0' },
    ],
    coupledCoinBook: [
      {
        referenceAsset: 'BTC',
        pairs: 1,
        longNotional: '10000',
        shortNotional: '10000',
        collateral: '20000',
        net: '0',
      },
    ],
    chainComparison: { source: 'ledger+chain', divergences: [], anyDivergence: false },
    notes: [],
  };
}

/** A group view carrying a ledger↔chain divergence (FR-10). */
export function divergentGroupView(): GroupViewResponse {
  const base = reconciledGroupView();
  const q = (decimal: string) => money('ROSE-L', 0, decimal, decimal);
  return {
    ...base,
    chainComparison: {
      source: 'ledger+chain',
      anyDivergence: true,
      divergences: [
        {
          asset: 'ROSE-L',
          scale: 0,
          ledgerQuantity: q('20000'),
          onChainTotalSupply: q('15000'),
          divergence: q('5000'),
          diverged: true,
        },
      ],
    },
  };
}

/** An empty group view (no balances yet). */
export function emptyGroupView(): GroupViewResponse {
  return {
    generatedAt: '2026-06-16T12:00:00.000Z',
    source: 'ledger-only',
    entities: [],
    consolidated: [],
    coupledPairs: [],
    covenants: [],
    netExposure: [],
    coupledCoinBook: [],
    chainComparison: { source: 'ledger-only', divergences: [], anyDivergence: false },
    notes: [],
  };
}

/** An ACTIVE coupled pair (`GET /coupled-pairs/:id` shape). */
export function activePair(): CoupledPairResponse {
  return {
    id: 'pair-1',
    referenceAsset: 'BTC',
    anchorPrice: '60000.00',
    leverage: '3',
    collateralPool: '20000',
    floor: '0.6',
    longLegValue: '10000',
    shortLegValue: '10000',
    state: 'ACTIVE',
    createdAt: '2026-06-16T10:00:00.000Z',
    updatedAt: '2026-06-16T12:00:00.000Z',
  };
}

/** A REBALANCING coupled pair (a losing leg breached the floor). */
export function rebalancingPair(): CoupledPairResponse {
  return {
    ...activePair(),
    state: 'REBALANCING',
    longLegValue: '5000',
    shortLegValue: '15000',
  };
}

// ─── Story 6.6: Exchange/Trading + Subscriber fixtures ──────────────────────────────────────────

// A TRADING_CO entity carrying live (paper/testnet) execution: DEPLOYED_CAPITAL (positions) +
// FEE_INCOME (realized P&L). The Exchange/Trading view derives positions/P&L by entity from this.
const tradingCoExec: GroupViewEntity = {
  entityCode: 'TRADING_CO',
  jurisdiction: 'KY',
  role: 'TRADING',
  reconciliationStatus: 'RECONCILED',
  accounts: [
    {
      accountId: 'tco-deployed-capital',
      type: 'DEPLOYED_CAPITAL',
      asset: 'EUR',
      scale: 2,
      navRole: 'ASSET',
      normalSide: 'DEBIT',
      totalDebit: eur('500000', '5000.00'),
      totalCredit: eur('0', '0.00'),
      net: eur('500000', '5000.00'),
    },
    {
      accountId: 'tco-fee-income',
      type: 'FEE_INCOME',
      asset: 'EUR',
      scale: 2,
      navRole: 'EQUITY',
      normalSide: 'CREDIT',
      totalDebit: eur('0', '0.00'),
      totalCredit: eur('125000', '1250.00'),
      net: eur('125000', '1250.00'),
    },
  ],
  byAsset: [
    {
      asset: 'EUR',
      scale: 2,
      assets: eur('500000', '5000.00'),
      liabilities: eur('0', '0.00'),
      equity: eur('125000', '1250.00'),
      nav: eur('625000', '6250.00'),
    },
  ],
};

/** A group view carrying live trading activity (TRADING_CO execution + an active pair). */
export function tradingGroupView(): GroupViewResponse {
  return {
    ...reconciledGroupView(),
    entities: [vcc, tradingCoExec],
  };
}

// A TRADING_CO whose realized P&L is NEGATIVE (a loss) — guards the delta sign+glyph rendering.
const tradingCoLoss: GroupViewEntity = {
  ...tradingCoExec,
  accounts: [
    tradingCoExec.accounts[0]!,
    {
      ...tradingCoExec.accounts[1]!,
      net: eur('-30000', '-300.00'),
    },
  ],
};

/** A group view whose TRADING_CO realized P&L is a loss (negative net). */
export function tradingLossGroupView(): GroupViewResponse {
  return {
    ...reconciledGroupView(),
    entities: [vcc, tradingCoLoss],
  };
}

/** A subscriber's Rose Note position handle (`GET /rose-notes/:id`). */
export function subscriberNote(): RoseNoteResponse {
  return {
    id: 'note-1',
    coupledPairId: 'pair-1',
    createdAt: '2026-06-16T10:00:00.000Z',
    updatedAt: '2026-06-16T12:00:00.000Z',
  };
}

/** A pending subscription (submitted on-chain, no journal entry yet — UX-DR6). */
export function pendingSubscription(): SubscriptionResponse {
  return {
    id: 'idem-1',
    roseNoteId: 'note-1',
    coupledPairId: 'pair-1',
    subscriber: `0x${'a'.repeat(40)}`,
    amount: '100000',
    paymentAsset: 'EUR',
    status: 'pending',
    txHash: '0xpendingtx',
    journalEntryId: null,
  };
}

/** A confirmed subscription (the on-chain commit point posted the balanced entry). */
export function confirmedSubscription(): SubscriptionResponse {
  return {
    ...pendingSubscription(),
    status: 'confirmed',
    journalEntryId: 'entry-1',
  };
}

/** A pending redemption (the inverse mirror). */
export function pendingRedemption(): RedemptionResponse {
  return {
    id: 'idem-r-1',
    roseNoteId: 'note-1',
    coupledPairId: 'pair-1',
    redeemer: `0x${'a'.repeat(40)}`,
    amount: '100000',
    paymentAsset: 'EUR',
    status: 'pending',
    txHash: '0xpendingburn',
    journalEntryId: null,
  };
}

// ─── Per-user positions + live marks (Story 8.4) ────────────────────────────────────────────────

/** An `OK` live mark: a connected oracle, a positive directional P&L (the long leg gained). */
function okMark(): PositionMark {
  return {
    status: 'OK',
    entryPrice: '60000.00',
    markPrice: '63000.00',
    floor: '0.6',
    distanceToFloor: '0.25000000',
    unrealizedPnl: '1500',
    floorBreached: false,
    provenance: { source: 'test-replay', asOf: '2026-06-16T12:00:00.000Z' },
    ageMs: 1200,
    freshnessBoundMs: 600000,
    flags: [],
  };
}

/** The honest "no price feed" mark (no oracle composed) — every trusted field null (UX-DR4). */
function noFeedMark(): PositionMark {
  return {
    status: 'NO_FEED',
    entryPrice: '60000.00',
    markPrice: null,
    floor: '0.6',
    distanceToFloor: null,
    unrealizedPnl: null,
    floorBreached: null,
    provenance: null,
    ageMs: null,
    freshnessBoundMs: null,
    flags: ['NO_FEED'],
  };
}

/** A `STALE` mark: the price is surfaced (for transparency) but the trusted P&L is null (UX-DR4). */
function staleMark(): PositionMark {
  return {
    ...noFeedMark(),
    status: 'STALE',
    markPrice: '63000.00',
    flags: ['STALE'],
  };
}

function position(side: 'LONG' | 'SHORT', mark: PositionMark, id = 'pos-1'): Position {
  return {
    id,
    coupledPairId: 'pair-1',
    owner: `0x${'a'.repeat(40)}`,
    referenceAsset: 'BTC',
    side,
    sizeUnits: '10000',
    entryPrice: '60000.00',
    collateral: '10000',
    leverage: '1',
    realizedPnl: '0',
    lifecycle: 'OPEN',
    createdAt: '2026-06-16T10:00:00.000Z',
    updatedAt: '2026-06-16T12:00:00.000Z',
    mark,
  };
}

/** A LONG BTC position with a live OK mark + positive directional P&L. */
export function okPosition(): Position {
  return position('LONG', okMark());
}

/** A position whose mark is the honest "no price feed" state. */
export function noFeedPosition(): Position {
  return position('LONG', noFeedMark());
}

/** A position whose mark is STALE (price surfaced, P&L untrusted). */
export function stalePosition(): Position {
  return position('LONG', staleMark());
}

/** A `GET /positions` listing for the demo owner. */
export function positionsResponse(positions: Position[] = [okPosition()]): PositionsResponse {
  return { owner: `0x${'a'.repeat(40)}`, positions };
}
