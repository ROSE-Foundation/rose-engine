// Story 3.4 — end-to-end enforcement of the P0 rule set through the DB-backed provider, with the
// authorization facts bound to PERSISTED state and the floor computed in NUMERIC (FR-8, NFR-2/4).
// Covers: the persisted-state binding (accountType validation, balance), the floor edges
// (above/below/absent), and the four headline outcomes (fee allow, principal deny, default deny).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateOffChainPolicy, ruleSpecV1 } from '@rose/rule-spec';
import { loadConfig } from '@rose/config';
import {
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import type { AuthorizationProvider } from '../provider/authorization-provider.js';
import { TransferRefusedError } from '../post-transfer.js';
import { AccountFactMismatchError, loadAccountFacts, readAccountBalance } from './account-state.js';
import { resolveOffChainEnv } from './resolve-env.js';
import { enforceTransfer } from './enforce-transfer.js';
import { loadDbOffChainPolicyProvider } from './db-policy-provider.js';
import { seedFlowPermissions } from './policy-store.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let provider: AuthorizationProvider;

const acct = {
  backingFloat: '',
  feeIncome: '',
  clientCollateral: '',
  funding: '',
  treasury: '',
  external: '',
};

// A full parked-parameter env so `loadConfig` succeeds; BACKING_FLOAT_FLOOR is the floor under test.
const CONFIG_ENV = {
  NOTE_COUPON: '0.05',
  USE_OF_PROCEEDS_SPLIT: '0.5',
  CONVERSION_TO_PARTICIPATION: '0.5',
  BACKING_FLOAT_FLOOR: '1000', // EUR scale 2 ⇒ 100000 smallest units
  MODEL_FLOOR_M: '0.1',
  MODEL_FLOOR_G: '0.1',
};

async function seedAccount(entity: string, type: string): Promise<string> {
  const e = await pool.query<{ id: string }>('SELECT id FROM entities WHERE code = $1', [entity]);
  const row = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, $2, 'EUR', 2) RETURNING id`,
    [e.rows[0]!.id, type],
  );
  return row.rows[0]!.id;
}

async function countRows(table: 'journal_entries' | 'postings'): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
}

/** Give BACKING_FLOAT a starting balance by DEBITing it against the funding account. */
async function fundBackingFloat(amount: bigint): Promise<void> {
  await recordJournalEntry(db, {
    description: 'seed backing float balance',
    postings: [
      { accountId: acct.backingFloat, direction: 'DEBIT', amount },
      { accountId: acct.funding, direction: 'CREDIT', amount },
    ],
  });
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  await seedFlowPermissions(db, generateOffChainPolicy(ruleSpecV1));
  provider = await loadDbOffChainPolicyProvider(db);
  acct.backingFloat = await seedAccount('VCC', 'BACKING_FLOAT');
  acct.feeIncome = await seedAccount('VCC', 'FEE_INCOME');
  acct.clientCollateral = await seedAccount('VCC', 'CLIENT_COLLATERAL');
  acct.funding = await seedAccount('VCC', 'DEPLOYED_CAPITAL');
  acct.treasury = await seedAccount('HOLDING', 'NOTE_LIABILITY');
  acct.external = await seedAccount('HOLDING', 'FEE_INCOME');
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE journal_entries CASCADE');
});

describe('account-state — persisted facts + NUMERIC balance (NFR-2)', () => {
  it('reads the exact balance as a bigint (DEBIT adds, CREDIT removes)', async () => {
    await fundBackingFloat(150_000n);
    expect(await readAccountBalance(db, acct.backingFloat)).toBe(150_000n);
    const facts = await loadAccountFacts(db, acct.backingFloat);
    expect(facts).toMatchObject({ type: 'BACKING_FLOAT', asset: 'EUR', decimalScale: 2 });
  });

  it('an account with no postings has a zero balance', async () => {
    expect(await readAccountBalance(db, acct.feeIncome)).toBe(0n);
  });
});

describe('resolve-env — floor computed in NUMERIC/bigint (NFR-2)', () => {
  it('computes a bigint floor and a boolean below-floor flag from persisted state', async () => {
    await fundBackingFloat(150_000n);
    const facts = await loadAccountFacts(db, acct.backingFloat);
    const env = await resolveOffChainEnv({
      executor: db,
      facts,
      amount: 40_000n,
      backingFloatFloorDecimal: '1000',
    });
    expect(typeof env.backingFloatFloor).toBe('bigint');
    expect(env.backingFloatFloor).toBe(100_000n); // 1000 EUR @ scale 2
    expect(env.postBalanceBelowFloor).toBe(false); // 150000 - 40000 = 110000 ≥ 100000
  });

  it('flags a below-floor post-balance', async () => {
    await fundBackingFloat(150_000n);
    const facts = await loadAccountFacts(db, acct.backingFloat);
    const env = await resolveOffChainEnv({
      executor: db,
      facts,
      amount: 60_000n,
      backingFloatFloorDecimal: '1000',
    });
    expect(env.postBalanceBelowFloor).toBe(true); // 150000 - 60000 = 90000 < 100000
  });

  it('an absent floor yields an empty env (⇒ REFUSE, never 0)', async () => {
    const facts = await loadAccountFacts(db, acct.backingFloat);
    const env = await resolveOffChainEnv({ executor: db, facts, amount: 40_000n });
    expect(env).toEqual({});
  });

  it('a non-BACKING_FLOAT source carries no floor fields', async () => {
    const facts = await loadAccountFacts(db, acct.feeIncome);
    const env = await resolveOffChainEnv({
      executor: db,
      facts,
      amount: 40_000n,
      backingFloatFloorDecimal: '1000',
    });
    expect(env).toEqual({});
  });

  it('a negative floor is treated as no usable floor (empty env ⇒ REFUSE, never permissive)', async () => {
    await fundBackingFloat(150_000n);
    const facts = await loadAccountFacts(db, acct.backingFloat);
    const env = await resolveOffChainEnv({
      executor: db,
      facts,
      amount: 40_000n,
      backingFloatFloorDecimal: '-1000',
    });
    expect(env).toEqual({});
  });
});

describe('enforceTransfer — headline P0 outcomes through the DB provider (AC-1)', () => {
  it('FEE_INCOME → treasury is ALLOWED (records one balanced entry)', async () => {
    const receipt = await enforceTransfer(
      { accountId: acct.feeIncome, accountType: 'FEE_INCOME', classification: 'NONE' },
      { accountId: acct.treasury, destinationKind: 'TREASURY' },
      250n,
      { provider, db, assetKind: 'VALUE', description: 'fee sweep' },
    );
    expect(receipt.postings).toHaveLength(2);
    expect(await countRows('journal_entries')).toBe(1);
  });

  it('CLIENT_COLLATERAL principal → external is DENIED (Model-A; nothing persists)', async () => {
    await expect(
      enforceTransfer(
        {
          accountId: acct.clientCollateral,
          accountType: 'CLIENT_COLLATERAL',
          classification: 'PRINCIPAL',
        },
        { accountId: acct.external, destinationKind: 'EXTERNAL' },
        100n,
        { provider, db, assetKind: 'VALUE', description: 'principal egress' },
      ),
    ).rejects.toMatchObject({ name: 'TransferRefusedError', effect: 'DENY' });
    expect(await countRows('postings')).toBe(0);
  });

  it('an uncovered flow is DENIED by default', async () => {
    await expect(
      enforceTransfer(
        { accountId: acct.funding, accountType: 'DEPLOYED_CAPITAL', classification: 'NONE' },
        { accountId: acct.external, destinationKind: 'EXTERNAL' },
        100n,
        { provider, db, assetKind: 'VALUE', description: 'uncovered' },
      ),
    ).rejects.toBeInstanceOf(TransferRefusedError);
    expect(await countRows('postings')).toBe(0);
  });
});

describe('enforceTransfer — BACKING_FLOAT floor enforcement (AC-1, NFR-4)', () => {
  it('egress that stays at/above the floor is ALLOWED', async () => {
    await fundBackingFloat(150_000n);
    const config = loadConfig(CONFIG_ENV);
    const receipt = await enforceTransfer(
      { accountId: acct.backingFloat, accountType: 'BACKING_FLOAT', classification: 'NONE' },
      { accountId: acct.external, destinationKind: 'EXTERNAL' },
      40_000n,
      { provider, db, assetKind: 'VALUE', description: 'float egress above floor', config },
    );
    expect(receipt.postings).toHaveLength(2);
    expect(await readAccountBalance(db, acct.backingFloat)).toBe(110_000n);
  });

  it('egress that would push below the floor is DENIED (nothing persists)', async () => {
    await fundBackingFloat(150_000n);
    const config = loadConfig(CONFIG_ENV);
    await expect(
      enforceTransfer(
        { accountId: acct.backingFloat, accountType: 'BACKING_FLOAT', classification: 'NONE' },
        { accountId: acct.external, destinationKind: 'EXTERNAL' },
        60_000n,
        { provider, db, assetKind: 'VALUE', description: 'float egress below floor', config },
      ),
    ).rejects.toMatchObject({ name: 'TransferRefusedError', effect: 'DENY' });
    expect(await readAccountBalance(db, acct.backingFloat)).toBe(150_000n); // unchanged
  });

  it('egress with the floor config ABSENT is REFUSED (never treated as 0)', async () => {
    await fundBackingFloat(150_000n);
    await expect(
      enforceTransfer(
        { accountId: acct.backingFloat, accountType: 'BACKING_FLOAT', classification: 'NONE' },
        { accountId: acct.external, destinationKind: 'EXTERNAL' },
        40_000n,
        { provider, db, assetKind: 'VALUE', description: 'float egress no floor' }, // no config
      ),
    ).rejects.toMatchObject({ name: 'TransferRefusedError', effect: 'REFUSE' });
    expect(await readAccountBalance(db, acct.backingFloat)).toBe(150_000n); // egress did not happen
  });

  it('egress with a misconfigured NEGATIVE floor is REFUSED (guard not silently nullified)', async () => {
    await fundBackingFloat(150_000n);
    await expect(
      enforceTransfer(
        { accountId: acct.backingFloat, accountType: 'BACKING_FLOAT', classification: 'NONE' },
        { accountId: acct.external, destinationKind: 'EXTERNAL' },
        40_000n,
        {
          provider,
          db,
          assetKind: 'VALUE',
          description: 'negative floor',
          config: { backingFloatFloor: '-1000' },
        },
      ),
    ).rejects.toMatchObject({ name: 'TransferRefusedError', effect: 'REFUSE' });
    expect(await readAccountBalance(db, acct.backingFloat)).toBe(150_000n); // egress did not happen
  });
});

describe('enforceTransfer — fact binding to persisted state (resolves Story 3.3 deferral)', () => {
  it('rejects a declared accountType that does not match the persisted account', async () => {
    await expect(
      enforceTransfer(
        // The account is BACKING_FLOAT, but the caller claims FEE_INCOME.
        { accountId: acct.backingFloat, accountType: 'FEE_INCOME', classification: 'NONE' },
        { accountId: acct.treasury, destinationKind: 'TREASURY' },
        100n,
        { provider, db, assetKind: 'VALUE', description: 'spoofed account type' },
      ),
    ).rejects.toBeInstanceOf(AccountFactMismatchError);
    expect(await countRows('postings')).toBe(0);
  });
});
