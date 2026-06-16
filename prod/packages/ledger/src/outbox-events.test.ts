// Story 5.2 — the persisted side of the outbox/saga dual-write (NFR-9 / NFR-3), test-first on the
// consistency invariants against a REAL local Postgres (same harness as the other ledger tests).
// Proves: migration 0007 applied (table + journal_entries.tx_hash); recordIntent idempotent on the
// idempotency key; duplicate tx_hash rejected (DB unique); legal transitions succeed and illegal
// ones are rejected (fail-closed); stampJournalEntryTxHash writes the on-chain hash onto a real
// journal entry (NFR-3); and pre-5.2 / off-chain journal entries keep tx_hash NULL (no regression).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateUp } from './migrate.js';
import { recordJournalEntry } from './repositories/journal-entries.js';
import {
  IllegalOutboxTransitionError,
  OutboxEventNotFoundError,
  findByIdempotencyKey,
  findByTxHash,
  listByStatus,
  markCompensated,
  markConfirmed,
  markFailed,
  recordIntent,
  recordSubmission,
  stampJournalEntryTxHash,
} from './repositories/outbox-events.js';

let pool: pg.Pool;
let db: RoseDb;
let eurDebit: string;
let eurCredit: string;

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  const vcc = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
  const entityId = vcc.rows[0]!.id;
  const mk = async (type: string, asset: string, scale: number) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, $2, $3, $4) RETURNING id`,
        [entityId, type, asset, scale],
      )
    ).rows[0]!.id;
  eurDebit = await mk('BACKING_FLOAT', 'EUR', 2);
  eurCredit = await mk('FEE_INCOME', 'EUR', 2);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE outbox_events, journal_entries CASCADE');
});

async function aJournalEntry(): Promise<string> {
  const { entry } = await recordJournalEntry(db, {
    description: 'paired mint effect',
    postings: [
      { accountId: eurDebit, direction: 'DEBIT', amount: 100n },
      { accountId: eurCredit, direction: 'CREDIT', amount: 100n },
    ],
  });
  return entry.id;
}

describe('migration 0007 — outbox_events + journal_entries.tx_hash', () => {
  it('created the outbox_events table', async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('public.outbox_events') IS NOT NULL AS exists`,
    );
    expect(rows[0]!.exists).toBe(true);
  });

  it('added a nullable tx_hash column to journal_entries (NFR-3)', async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'journal_entries' AND column_name = 'tx_hash'`,
    );
    expect(rows[0]!.is_nullable).toBe('YES');
  });

  it('leaves tx_hash NULL on an off-chain-only journal entry (no regression)', async () => {
    const id = await aJournalEntry();
    const { rows } = await pool.query<{ tx_hash: string | null }>(
      'SELECT tx_hash FROM journal_entries WHERE id = $1',
      [id],
    );
    expect(rows[0]!.tx_hash).toBeNull();
  });
});

describe('recordIntent — idempotent on the idempotency key (NFR-9)', () => {
  it('records a PENDING intent and posts NO journal entry', async () => {
    const row = await recordIntent(db, {
      idempotencyKey: 'op-1',
      operationKind: 'PAIR_MINT',
      payload: { amount: '1000' },
    });
    expect(row.status).toBe('PENDING');
    expect(row.txHash).toBeNull();
    expect(row.journalEntryId).toBeNull();
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries',
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('returns the SAME row for a repeated idempotency key (no duplicate intent)', async () => {
    const first = await recordIntent(db, {
      idempotencyKey: 'op-dup',
      operationKind: 'PAIR_MINT',
      payload: { amount: '1000' },
    });
    const second = await recordIntent(db, {
      idempotencyKey: 'op-dup',
      operationKind: 'PAIR_MINT',
      payload: { amount: '9999' },
    });
    expect(second.id).toBe(first.id);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM outbox_events',
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('rejects an empty idempotency key', async () => {
    await expect(
      recordIntent(db, { idempotencyKey: '   ', operationKind: 'PAIR_MINT', payload: {} }),
    ).rejects.toThrow();
  });
});

describe('lifecycle transitions (fail-closed)', () => {
  it('PENDING -> SUBMITTED records the tx hash', async () => {
    const intent = await recordIntent(db, {
      idempotencyKey: 'op-2',
      operationKind: 'PAIR_BURN',
      payload: { amount: '500' },
    });
    const submitted = await recordSubmission(db, { id: intent.id, txHash: '0xabc' });
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.txHash).toBe('0xabc');
  });

  it('rejects a duplicate tx hash across rows (DB unique — tx idempotency)', async () => {
    const a = await recordIntent(db, {
      idempotencyKey: 'op-a',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    const b = await recordIntent(db, {
      idempotencyKey: 'op-b',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await recordSubmission(db, { id: a.id, txHash: '0xsame' });
    await expect(recordSubmission(db, { id: b.id, txHash: '0xsame' })).rejects.toThrow();
  });

  it('re-submitting the SAME tx hash is idempotent', async () => {
    const intent = await recordIntent(db, {
      idempotencyKey: 'op-resub',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await recordSubmission(db, { id: intent.id, txHash: '0xresub' });
    const again = await recordSubmission(db, { id: intent.id, txHash: '0xresub' });
    expect(again.status).toBe('SUBMITTED');
  });

  it('rejects PENDING -> CONFIRMED (must be submitted first)', async () => {
    const intent = await recordIntent(db, {
      idempotencyKey: 'op-3',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    const jeId = await aJournalEntry();
    await expect(markConfirmed(db, { id: intent.id, journalEntryId: jeId })).rejects.toBeInstanceOf(
      IllegalOutboxTransitionError,
    );
  });

  it('SUBMITTED -> CONFIRMED links the journal entry (commit point)', async () => {
    const intent = await recordIntent(db, {
      idempotencyKey: 'op-4',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await recordSubmission(db, { id: intent.id, txHash: '0xc4' });
    const jeId = await aJournalEntry();
    const confirmed = await markConfirmed(db, { id: intent.id, journalEntryId: jeId });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.journalEntryId).toBe(jeId);
  });

  it('FAILED -> COMPENSATED, and a confirmed row cannot be failed', async () => {
    const intent = await recordIntent(db, {
      idempotencyKey: 'op-5',
      operationKind: 'PAIR_BURN',
      payload: {},
    });
    const failed = await markFailed(db, { id: intent.id, error: 'tx reverted' });
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe('tx reverted');
    const comp = await markCompensated(db, intent.id);
    expect(comp.status).toBe('COMPENSATED');
    await expect(markFailed(db, { id: comp.id, error: 'x' })).rejects.toBeInstanceOf(
      IllegalOutboxTransitionError,
    );
  });

  it('throws OutboxEventNotFoundError for an unknown id', async () => {
    await expect(
      recordSubmission(db, { id: '00000000-0000-0000-0000-000000000000', txHash: '0xZ' }),
    ).rejects.toBeInstanceOf(OutboxEventNotFoundError);
  });
});

describe('stampJournalEntryTxHash (NFR-3) + lookups', () => {
  it('writes the on-chain tx hash onto the journal entry', async () => {
    const jeId = await aJournalEntry();
    await stampJournalEntryTxHash(db, { journalEntryId: jeId, txHash: '0xdeadbeef' });
    const { rows } = await pool.query<{ tx_hash: string | null }>(
      'SELECT tx_hash FROM journal_entries WHERE id = $1',
      [jeId],
    );
    expect(rows[0]!.tx_hash).toBe('0xdeadbeef');
  });

  it('re-stamping the same hash is a no-op; a different hash is rejected', async () => {
    const jeId = await aJournalEntry();
    await stampJournalEntryTxHash(db, { journalEntryId: jeId, txHash: '0xsame' });
    await stampJournalEntryTxHash(db, { journalEntryId: jeId, txHash: '0xsame' });
    await expect(
      stampJournalEntryTxHash(db, { journalEntryId: jeId, txHash: '0xother' }),
    ).rejects.toThrow();
  });

  it('rejects stamping the SAME tx hash onto two different journal entries (UNIQUE backstop, NFR-3)', async () => {
    const a = await aJournalEntry();
    const b = await aJournalEntry();
    await stampJournalEntryTxHash(db, { journalEntryId: a, txHash: '0xonce' });
    // The DB UNIQUE (tx_hash) constraint makes a duplicate ledger post for one on-chain tx impossible.
    await expect(
      stampJournalEntryTxHash(db, { journalEntryId: b, txHash: '0xonce' }),
    ).rejects.toThrow();
  });

  it('findByIdempotencyKey / findByTxHash / listByStatus resolve rows', async () => {
    const intent = await recordIntent(db, {
      idempotencyKey: 'op-find',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await recordSubmission(db, { id: intent.id, txHash: '0xfind' });
    expect((await findByIdempotencyKey(db, 'op-find'))?.id).toBe(intent.id);
    expect((await findByTxHash(db, '0xfind'))?.id).toBe(intent.id);
    expect((await listByStatus(db, 'SUBMITTED')).map((r) => r.id)).toContain(intent.id);
  });
});
