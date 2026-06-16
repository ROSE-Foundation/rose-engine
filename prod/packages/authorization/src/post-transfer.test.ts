// Story 3.3 — the RUNTIME half of the chokepoint guard + the conformance-vector behaviour suite.
//
// Test-first on the two invariants:
//  (1) fail-closed chokepoint — `authorize` is consulted before any write, and a non-ALLOW
//      decision writes NOTHING (proven against the LIVE Postgres by asserting zero new rows). The
//      10 shared conformance vectors (Story 3.1) define the ALLOW/DENY/REFUSE outcomes.
//  (2) the chokepoint is the only transfer-posting writer (the static half is in
//      `chokepoint-guard.test.ts`; here we prove the write happens ONLY on ALLOW).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conformanceVectors,
  generateOffChainPolicy,
  ruleSpecV1,
  type AccountTypeCode,
  type DestinationKind,
} from '@rose/rule-spec';
import { createDb, createPool, hardReset, migrateUp, type RoseDb } from '@rose/ledger';
import { makePolicyAuthorizationProvider } from './provider/policy-authorization-provider.js';
import type { AuthorizationProvider } from './provider/authorization-provider.js';
import {
  InvalidTransferError,
  TransferRefusedError,
  postTransfer,
  type TransferLogger,
  type TransferSource,
} from './post-transfer.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

const ALL_TYPES: readonly AccountTypeCode[] = [
  'BACKING_FLOAT',
  'DEPLOYED_CAPITAL',
  'CLIENT_COLLATERAL',
  'FEE_INCOME',
  'NOTE_LIABILITY',
];

// One source ledger account per account type (under VCC) and one counter-account per logical
// destination kind (under HOLDING) — all EUR scale 2 so a transfer entry balances per-(asset,scale).
const sourceByType = new Map<AccountTypeCode, string>();
const destByKind = new Map<DestinationKind, string>();

async function seedAccount(entity: string, type: string): Promise<string> {
  const e = await pool.query<{ id: string }>('SELECT id FROM entities WHERE code = $1', [entity]);
  const entityId = e.rows[0]!.id;
  const row = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, $2, 'EUR', 2) RETURNING id`,
    [entityId, type],
  );
  return row.rows[0]!.id;
}

async function countRows(table: 'journal_entries' | 'postings'): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
}

/** A constant-effect spy provider that records how many times it was consulted. */
function spyProvider(
  effect: 'ALLOW' | 'DENY' | 'REFUSE',
): AuthorizationProvider & { calls: number } {
  return {
    name: `spy-${effect}`,
    calls: 0,
    authorize() {
      this.calls += 1;
      return { effect, reason: `spy says ${effect}` };
    },
  };
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  for (const t of ALL_TYPES) sourceByType.set(t, await seedAccount('VCC', t));
  // Distinct (entity,type,asset) counter-accounts; their account TYPE is irrelevant to
  // authorization (which uses the logical destinationKind) — they only need to exist + share asset.
  destByKind.set('TREASURY', await seedAccount('HOLDING', 'NOTE_LIABILITY'));
  destByKind.set('CLIENT_ACCOUNT', await seedAccount('HOLDING', 'CLIENT_COLLATERAL'));
  destByKind.set('EXTERNAL', await seedAccount('HOLDING', 'FEE_INCOME'));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE journal_entries CASCADE');
});

const feeSource: TransferSource = {
  accountId: '', // filled in beforeAll via map; set per-test below
  accountType: 'FEE_INCOME',
  classification: 'NONE',
};

describe('postTransfer — fail-closed runtime guard (AC-1)', () => {
  it('a DENY decision writes NOTHING and throws TransferRefusedError', async () => {
    const provider = spyProvider('DENY');
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    await expect(
      postTransfer(
        from,
        { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
        100n,
        { provider, db, assetKind: 'VALUE', env: {}, description: 'denied sweep' },
      ),
    ).rejects.toBeInstanceOf(TransferRefusedError);
    expect(provider.calls).toBe(1); // authorization WAS consulted
    expect(await countRows('journal_entries')).toBe(0); // ...but nothing was written
    expect(await countRows('postings')).toBe(0);
  });

  it('a REFUSE decision also writes NOTHING (effect carried on the error)', async () => {
    const provider = spyProvider('REFUSE');
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    await expect(
      postTransfer(
        from,
        { accountId: destByKind.get('EXTERNAL')!, destinationKind: 'EXTERNAL' },
        100n,
        { provider, db, assetKind: 'VALUE', env: {}, description: 'refused egress' },
      ),
    ).rejects.toMatchObject({ name: 'TransferRefusedError', effect: 'REFUSE' });
    expect(await countRows('postings')).toBe(0);
  });

  it('an ALLOW decision records exactly one balanced entry (CREDIT from, DEBIT to)', async () => {
    const provider = spyProvider('ALLOW');
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    const receipt = await postTransfer(
      from,
      { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
      250n,
      { provider, db, assetKind: 'VALUE', env: {}, description: 'allowed sweep' },
    );
    expect(receipt.postings).toHaveLength(2);
    const credit = receipt.postings.find((p) => p.direction === 'CREDIT')!;
    const debit = receipt.postings.find((p) => p.direction === 'DEBIT')!;
    expect(credit.accountId).toBe(sourceByType.get('FEE_INCOME'));
    expect(debit.accountId).toBe(destByKind.get('TREASURY'));
    expect(credit.amount).toBe(250n);
    expect(debit.amount).toBe(250n);
    expect(await countRows('journal_entries')).toBe(1);
    expect(await countRows('postings')).toBe(2);
  });

  it('authorize is consulted BEFORE the write (logger observes the decision; DENY logs warn)', async () => {
    const provider = spyProvider('DENY');
    const events: string[] = [];
    const logger: TransferLogger = {
      info: () => events.push('info'),
      warn: () => events.push('warn'),
    };
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    await expect(
      postTransfer(
        from,
        { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
        100n,
        { provider, db, assetKind: 'VALUE', env: {}, description: 'denied', logger },
      ),
    ).rejects.toBeInstanceOf(TransferRefusedError);
    expect(events).toEqual(['warn']); // decision logged, then thrown — no write path reached
  });
});

describe('postTransfer — amount validation (NFR-2)', () => {
  it('rejects a non-positive amount WITHOUT consulting the provider or writing', async () => {
    const provider = spyProvider('ALLOW');
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    for (const bad of [0n, -5n]) {
      await expect(
        postTransfer(
          from,
          { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
          bad,
          {
            provider,
            db,
            assetKind: 'VALUE',
            env: {},
            description: 'bad amount',
          },
        ),
      ).rejects.toBeInstanceOf(InvalidTransferError);
    }
    expect(provider.calls).toBe(0);
    expect(await countRows('postings')).toBe(0);
  });

  it('rejects a JS-number (float) amount (NFR-2)', async () => {
    const provider = spyProvider('ALLOW');
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    // The `amount: bigint` signature already rejects a number at compile time for typed callers;
    // this simulates an UNTYPED JS caller smuggling a float past the type system to prove the
    // RUNTIME guard (assertNotFloat) still rejects it (NFR-2).
    const floatAmount = 1.5 as unknown as bigint;
    await expect(
      postTransfer(
        from,
        { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
        floatAmount,
        {
          provider,
          db,
          assetKind: 'VALUE',
          env: {},
          description: 'float amount',
        },
      ),
    ).rejects.toBeInstanceOf(InvalidTransferError);
    expect(provider.calls).toBe(0);
  });
});

describe('postTransfer — well-formedness guards (review hardening)', () => {
  it('rejects a self-transfer (from === to) WITHOUT consulting the provider or writing', async () => {
    const provider = spyProvider('ALLOW');
    const same = sourceByType.get('FEE_INCOME')!;
    await expect(
      postTransfer(
        { ...feeSource, accountId: same },
        { accountId: same, destinationKind: 'TREASURY' },
        100n,
        { provider, db, assetKind: 'VALUE', env: {}, description: 'self transfer' },
      ),
    ).rejects.toBeInstanceOf(InvalidTransferError);
    expect(provider.calls).toBe(0);
    expect(await countRows('postings')).toBe(0);
  });

  it('emits the ALLOW audit log only AFTER a successful write', async () => {
    const provider = spyProvider('ALLOW');
    const events: string[] = [];
    const logger: TransferLogger = {
      info: () => events.push('info'),
      warn: () => events.push('warn'),
    };
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    await postTransfer(
      from,
      { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
      100n,
      { provider, db, assetKind: 'VALUE', env: {}, description: 'allowed', logger },
    );
    expect(events).toEqual(['info']);
    expect(await countRows('journal_entries')).toBe(1);
  });
});

describe('postTransfer — transaction composition (RoseExecutor)', () => {
  it('writes inside an outer transaction; an outer rollback discards the transfer', async () => {
    const provider = spyProvider('ALLOW');
    const from: TransferSource = { ...feeSource, accountId: sourceByType.get('FEE_INCOME')! };
    await expect(
      db.transaction(async (tx) => {
        await postTransfer(
          from,
          { accountId: destByKind.get('TREASURY')!, destinationKind: 'TREASURY' },
          100n,
          { provider, db: tx, assetKind: 'VALUE', env: {}, description: 'tx then rollback' },
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(await countRows('journal_entries')).toBe(0); // the transfer was rolled back with the tx
    expect(await countRows('postings')).toBe(0);
  });
});

describe('postTransfer — the 10 shared conformance vectors define the decisions (AC-1)', () => {
  const provider = makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1));

  it('exercises a non-empty vector set (non-vacuous)', () => {
    expect(conformanceVectors.length).toBe(10);
  });

  for (const vec of conformanceVectors) {
    it(`vector ${vec.id} (expects ${vec.expected}) is enforced by postTransfer`, async () => {
      const from: TransferSource = {
        accountId: sourceByType.get(vec.scenario.from)!,
        accountType: vec.scenario.from,
        classification: vec.scenario.classification,
      };
      const to = { accountId: destByKind.get(vec.scenario.to)!, destinationKind: vec.scenario.to };
      const ctx = {
        provider,
        db,
        assetKind: vec.scenario.assetKind,
        throughVcc: vec.scenario.throughVcc,
        env: vec.env,
        description: vec.id,
      };

      if (vec.expected === 'ALLOW') {
        const receipt = await postTransfer(from, to, 100n, ctx);
        expect(receipt.postings).toHaveLength(2);
        expect(await countRows('journal_entries')).toBe(1);
        expect(await countRows('postings')).toBe(2);
      } else {
        await expect(postTransfer(from, to, 100n, ctx)).rejects.toMatchObject({
          name: 'TransferRefusedError',
          effect: vec.expected,
        });
        expect(await countRows('journal_entries')).toBe(0);
        expect(await countRows('postings')).toBe(0);
      }
    });
  }
});
