// Story 5.4 — the paired-burn dual-write proven END-TO-END against the LOCAL Postgres (NO Sepolia, NO
// network, NO wallet key for the asserted flow). The on-chain `submit` is injected as a deterministic
// hash and the confirmation is a SYNTHETIC Story-5.1 `PairBurnedEvent` (the 5.2/5.3 philosophy), so the
// COMMIT-POINT recording is proven deterministically:
//   AC-1: ONE balanced journal entry linked to the coupled pair captures quantity + value, posted ONLY
//         at confirmation (zero entries after submit).
//   AC-2: ledger RETIRED token quantity == on-chain `PairBurned.amount` (NFR-9), supply RETIRED (holder
//         leg net CREDIT, supply contra net DEBIT — the inverse of mint); a single-leg / mis-asseted
//         burn is rejected; replaying the confirmed event posts the entry once (idempotent).
//   Fail-closed: a pre-submit DENY or a quantity divergence posts NOTHING (NFR-4 / NFR-9).
//   NFR-3: the on-chain tx hash is stamped on the related journal entry.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { custom, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordIntent,
  recordSubmission,
  type RoseDb,
} from '@rose/ledger';
import { createRoseChainClients } from '../viem-clients.js';
import type { ChainConfig } from '../chain-config.js';
import { OutboxSaga } from '../outbox/outbox-saga.js';
import type { PairBurnedEvent } from '../watchers.js';
import {
  BurnAuthorizationError,
  BurnPairDualWrite,
  BurnQuantityDivergenceError,
  type BurnLedgerPlan,
} from './burn-pair.js';

const L_FROM: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const S_FROM: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIR_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const BURN_TX = '0xabc0000000000000000000000000000000000000000000000000000000000def';
const AMOUNT = 1000n;

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let saga: OutboxSaga;
let burn: BurnPairDualWrite;

// Token-quantity accounts (one asset per leg so each leg balances within its asset) + value accounts.
let lHolder: string;
let lSupply: string;
let sHolder: string;
let sSupply: string;
let eurDeployed: string;
let eurFloat: string;
let pairId: string;

function chainConfig(): ChainConfig {
  return {
    sepoliaRpcUrl: 'http://127.0.0.1:8545',
    pairAddress: PAIR_ADDRESS,
    lTokenAddress: '0x2222222222222222222222222222222222222222',
    sTokenAddress: '0x3333333333333333333333333333333333333333',
    identityRegistryAddress: '0x4444444444444444444444444444444444444444',
  };
}

async function mkAccount(
  entityId: string,
  type: string,
  asset: string,
  scale: number,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, $2, $3, $4) RETURNING id`,
    [entityId, type, asset, scale],
  );
  return r.rows[0]!.id;
}

async function count(table: 'journal_entries' | 'postings'): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0]!.n;
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  saga = new OutboxSaga({ db }); // defaults to the @rose/ledger-backed ledgerOutboxStore
  // confirmFromBurnedEvent never touches the clients/account — supply a mock so the orchestrator is
  // fully constructed (the on-chain write path is covered in burn-pair.test.ts, no network here).
  const clients = createRoseChainClients(chainConfig(), {
    transport: custom({ request: async () => '0x0' }),
  });
  burn = new BurnPairDualWrite({ saga, clients, account: privateKeyToAccount(TEST_PK) });

  const vcc = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
  const entityId = vcc.rows[0]!.id;
  lHolder = await mkAccount(entityId, 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
  lSupply = await mkAccount(entityId, 'NOTE_LIABILITY', 'ROSE_L', 0);
  sHolder = await mkAccount(entityId, 'CLIENT_COLLATERAL', 'ROSE_S', 0);
  sSupply = await mkAccount(entityId, 'FEE_INCOME', 'ROSE_S', 0);
  eurDeployed = await mkAccount(entityId, 'DEPLOYED_CAPITAL', 'EUR', 2);
  eurFloat = await mkAccount(entityId, 'BACKING_FLOAT', 'EUR', 2);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE coupled_pairs, journal_entries, outbox_events CASCADE');
  const pair = await createCoupledPair(db, {
    referenceAsset: 'EUR/USD',
    anchorPrice: '1.10500000',
    leverage: '1',
    collateralPool: 1_000_000n,
    floor: '0.5',
    longLegValue: 500_000n,
    shortLegValue: 500_000n,
    state: 'ACTIVE',
  });
  pairId = pair.id;
});

function payload() {
  return { coupledPairId: pairId, lFrom: L_FROM, sFrom: S_FROM, amount: AMOUNT.toString() };
}

// A balanced plan: L/S quantity legs RETIRED + an EUR value movement (redemption releases deployed
// capital back to the float). Authorization is enforced PRE-submit in `start`, not in the commit-point
// effect — see the start-level fail-closed test below.
function allowPlan(): BurnLedgerPlan {
  return {
    description: 'burn (redeem) EUR/USD coupled pair',
    longLeg: { holderAccountId: lHolder, supplyAccountId: lSupply },
    shortLeg: { holderAccountId: sHolder, supplyAccountId: sSupply },
    value: {
      postings: [
        { accountId: eurFloat, direction: 'DEBIT', amount: 500_000n },
        { accountId: eurDeployed, direction: 'CREDIT', amount: 500_000n },
      ],
    },
  };
}

function burnedEvent(amount = AMOUNT, txHash = BURN_TX): PairBurnedEvent {
  return {
    eventName: 'PairBurned',
    args: { lFrom: L_FROM, sFrom: S_FROM, amount },
    address: PAIR_ADDRESS,
    blockNumber: 101n,
    transactionHash: txHash as `0x${string}`,
    logIndex: 0,
  };
}

/** Records the intent (PENDING) + submission (SUBMITTED, deterministic hash) — no on-chain write. */
async function seedSubmitted(txHash = BURN_TX): Promise<string> {
  const intent = await recordIntent(db, {
    idempotencyKey: `burn-${txHash}`,
    operationKind: 'PAIR_BURN',
    payload: payload(),
  });
  await recordSubmission(db, { id: intent.id, txHash });
  return intent.id;
}

describe('AC-1 — the balanced burn entry is posted ONLY at the commit point', () => {
  it('posts nothing at submission, then ONE balanced entry (quantity + value) linked to the pair on confirm', async () => {
    const id = await seedSubmitted();
    // Commit-point ordering: nothing recorded at SUBMITTED.
    expect(await count('journal_entries')).toBe(0);

    const result = await burn.confirmFromBurnedEvent(burnedEvent(), allowPlan());
    expect(result.status).toBe('applied');

    // Exactly ONE journal entry, linked to the pair, capturing both quantity legs + the value legs.
    expect(await count('journal_entries')).toBe(1);
    const je = await pool.query<{ id: string; coupled_pair_id: string; tx_hash: string }>(
      'SELECT id, coupled_pair_id, tx_hash FROM journal_entries',
    );
    expect(je.rows[0]!.coupled_pair_id).toBe(pairId);
    // NFR-3: the on-chain tx hash is stamped on the related journal entry.
    expect(je.rows[0]!.tx_hash).toBe(BURN_TX);

    // 4 quantity postings (L holder/supply, S holder/supply) + 2 value postings.
    expect(await count('postings')).toBe(6);

    // The outbox row is CONFIRMED and linked to the posted entry.
    const outbox = await pool.query<{ status: string; journal_entry_id: string }>(
      'SELECT status, journal_entry_id FROM outbox_events WHERE id = $1',
      [id],
    );
    expect(outbox.rows[0]!.status).toBe('CONFIRMED');
    expect(outbox.rows[0]!.journal_entry_id).toBe(je.rows[0]!.id);
  });
});

describe('AC-2 — ledger retired quantity matches the on-chain burned amount, supply RETIRED (NFR-9)', () => {
  it('records each leg quantity retired equal to the confirmed on-chain PairBurned.amount', async () => {
    await seedSubmitted();
    await burn.confirmFromBurnedEvent(burnedEvent(AMOUNT), allowPlan());

    const balances = await pool.query<{ account_id: string; bal: string }>(
      `SELECT account_id,
              sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text AS bal
         FROM postings GROUP BY account_id`,
    );
    const bal = new Map(balances.rows.map((r) => [r.account_id, BigInt(r.bal)]));
    // A burn RETIRES supply: each holder leg is CREDITED (net -amount) and the supply contra DEBITED
    // (net +amount) — the exact INVERSE of mint. Magnitude == the on-chain burned amount (NFR-9).
    expect(bal.get(lHolder)).toBe(-AMOUNT);
    expect(bal.get(lSupply)).toBe(AMOUNT);
    expect(bal.get(sHolder)).toBe(-AMOUNT);
    expect(bal.get(sSupply)).toBe(AMOUNT);
    // The redemption value notional is also recorded in the same entry.
    expect(bal.get(eurFloat)).toBe(500_000n);
    expect(bal.get(eurDeployed)).toBe(-500_000n);
  });

  it('replaying the same confirmed PairBurned does NOT double the ledger entry (idempotent)', async () => {
    await seedSubmitted();
    const first = await burn.confirmFromBurnedEvent(burnedEvent(), allowPlan());
    const second = await burn.confirmFromBurnedEvent(burnedEvent(), allowPlan());
    expect(first.status).toBe('applied');
    expect(second.status).toBe('noop'); // already CONFIRMED — no-op
    expect(await count('journal_entries')).toBe(1);
    expect(await count('postings')).toBe(6);
  });
});

describe('fail-closed — authorization (pre-submit) and confirm-time anomalies post NOTHING', () => {
  it('a DENY authorization vetoes the dual-write BEFORE submit: no intent, no on-chain burn, nothing recorded', async () => {
    await expect(
      burn.start({
        idempotencyKey: 'burn-deny',
        coupledPairId: pairId,
        pairAddress: PAIR_ADDRESS,
        lFrom: L_FROM,
        sFrom: S_FROM,
        amount: AMOUNT,
        authorize: () => ({ effect: 'DENY', reason: 'not authorized' }),
      }),
    ).rejects.toBeInstanceOf(BurnAuthorizationError);
    expect(await count('journal_entries')).toBe(0);
    const outbox = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox_events');
    expect(outbox.rows[0]!.n).toBe(0); // no intent persisted (fail-closed pre-submit)
  });

  it('a confirmed amount diverging from the recorded intent is a non-applied anomaly, records nothing (NFR-9)', async () => {
    const id = await seedSubmitted();
    const outcome = await burn.confirmFromBurnedEvent(burnedEvent(999n), allowPlan());
    expect(outcome.status).toBe('anomaly');
    if (outcome.status === 'anomaly') {
      expect(outcome.error).toBeInstanceOf(BurnQuantityDivergenceError);
    }
    expect(await count('journal_entries')).toBe(0);
    // The row stays SUBMITTED (commit-point flip rolled back) for reconcile (5.6) — never thrown.
    const outbox = await pool.query<{ status: string }>(
      'SELECT status FROM outbox_events WHERE id = $1',
      [id],
    );
    expect(outbox.rows[0]!.status).toBe('SUBMITTED');
  });

  it('a mis-asseted plan is a non-applied anomaly via the per-asset balance backstop (nothing persists)', async () => {
    await seedSubmitted();
    // Long-leg supply contra points at an EUR account ⇒ the ROSE_L credit and the EUR debit each stand
    // alone within their asset group, so the entry cannot balance per (asset, scale).
    const badPlan: BurnLedgerPlan = {
      description: 'mis-asseted burn',
      longLeg: { holderAccountId: lHolder, supplyAccountId: eurFloat },
      shortLeg: { holderAccountId: sHolder, supplyAccountId: sSupply },
    };
    const outcome = await burn.confirmFromBurnedEvent(burnedEvent(), badPlan);
    expect(outcome.status).toBe('anomaly');
    expect(await count('journal_entries')).toBe(0);
  });
});
