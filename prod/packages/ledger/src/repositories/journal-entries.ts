// Journal-entry recording primitive (FR-2, NFR-2/NFR-3). Records an economic event as a
// balanced journal entry of ≥2 postings in a single transaction; the DB double-entry trigger
// (Story 1.5) is the non-bypassable backstop, while this layer gives friendly domain errors
// and enforces the ≥2-postings / non-empty-description / integer-amount rules. Append-oriented:
// only record + read are exposed (no mutation) — the audit trail is the surface.
import { asc, eq, inArray } from 'drizzle-orm';
import { assertNotFloat } from '@rose/shared';
import type { RoseDb, RoseExecutor } from '../db.js';
import { accounts, journalEntries, postings } from '../schema/index.js';
import type { JournalEntry, PostingDirection } from '../schema/index.js';

export interface RecordPostingInput {
  readonly accountId: string;
  readonly direction: PostingDirection;
  /** Integer amount in the account's smallest unit. */
  readonly amount: bigint;
}

export interface RecordJournalEntryInput {
  readonly description: string;
  readonly coupledPairId?: string | null;
  readonly postings: ReadonlyArray<RecordPostingInput>;
}

/** A posting with its amount as an integer bigint (smallest units). */
export interface PostingView {
  readonly id: string;
  readonly journalEntryId: string;
  readonly accountId: string;
  readonly direction: PostingDirection;
  readonly amount: bigint;
  readonly createdAt: Date;
}

export interface JournalEntryWithPostings {
  readonly entry: JournalEntry;
  readonly postings: PostingView[];
}

/** Thrown when an entry is structurally invalid (too few postings, empty description, bad amount). */
export class InvalidJournalEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJournalEntryError';
  }
}

/** Thrown when an entry does not balance within some (asset, scale) group. */
export class UnbalancedEntryError extends Error {
  readonly asset: string;
  readonly scale: number;
  readonly totalDebit: bigint;
  readonly totalCredit: bigint;
  constructor(asset: string, scale: number, totalDebit: bigint, totalCredit: bigint) {
    super(
      `Unbalanced journal entry for asset '${asset}' (scale ${scale}): debits ${totalDebit} <> credits ${totalCredit}.`,
    );
    this.name = 'UnbalancedEntryError';
    this.asset = asset;
    this.scale = scale;
    this.totalDebit = totalDebit;
    this.totalCredit = totalCredit;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse a NUMERIC string to a bigint. The DB CHECK guarantees integer VALUE but not scale 0,
// so a non-app writer could store "100.000"; accept an all-zero fraction, reject a real one.
function numericToBigInt(value: string): bigint {
  const [intPart = '0', fracPart] = value.split('.');
  if (fracPart !== undefined && /[^0]/.test(fracPart)) {
    throw new Error(`Non-integer amount '${value}' read from ledger (smallest-units contract).`);
  }
  return BigInt(intPart);
}

function toView(row: {
  id: string;
  journalEntryId: string;
  accountId: string;
  direction: PostingDirection;
  amount: string;
  createdAt: Date;
}): PostingView {
  return { ...row, amount: numericToBigInt(row.amount) };
}

/**
 * Records a balanced journal entry of ≥2 postings against accounts. Validates structure and
 * per-(asset, scale) balance, then inserts the entry + postings in one transaction. Returns
 * the persisted entry with its postings. Throws InvalidJournalEntryError / UnbalancedEntryError.
 * Accepts a `RoseExecutor` so it can run inside an outer `db.transaction(...)` (its own
 * `db.transaction` then becomes a nested savepoint) — e.g. coupled-pair issuance (Story 2.3).
 */
export async function recordJournalEntry(
  db: RoseExecutor,
  input: RecordJournalEntryInput,
): Promise<JournalEntryWithPostings> {
  if (input.description.trim().length === 0) {
    throw new InvalidJournalEntryError('Journal entry description must be non-empty.');
  }
  if (input.postings.length < 2) {
    throw new InvalidJournalEntryError('A journal entry requires at least two postings.');
  }
  if (input.coupledPairId != null && !UUID_PATTERN.test(input.coupledPairId)) {
    throw new InvalidJournalEntryError(
      `coupledPairId '${input.coupledPairId}' is not a valid UUID.`,
    );
  }
  for (const p of input.postings) {
    try {
      assertNotFloat(p.amount); // NFR-2: a JS number/float is never a valid amount
    } catch {
      throw new InvalidJournalEntryError(
        'Posting amount must be a bigint in smallest units, never a binary float (NFR-2).',
      );
    }
    if (typeof p.amount !== 'bigint') {
      throw new InvalidJournalEntryError('Posting amount must be a bigint in smallest units.');
    }
    if (p.amount <= 0n) {
      throw new InvalidJournalEntryError('Posting amount must be a positive integer.');
    }
    if (p.direction !== 'DEBIT' && p.direction !== 'CREDIT') {
      throw new InvalidJournalEntryError(`Invalid posting direction '${p.direction}'.`);
    }
  }

  // Load the referenced accounts to balance per (asset, scale).
  const accountIds = [...new Set(input.postings.map((p) => p.accountId))];
  const accountRows = await db.select().from(accounts).where(inArray(accounts.id, accountIds));
  const byId = new Map(accountRows.map((a) => [a.id, a]));
  for (const p of input.postings) {
    if (!byId.has(p.accountId)) {
      throw new InvalidJournalEntryError(`Account '${p.accountId}' not found.`);
    }
  }

  // Per-(asset, scale) debit/credit totals — you cannot net EUR against BTC.
  const groups = new Map<string, { asset: string; scale: number; debit: bigint; credit: bigint }>();
  for (const p of input.postings) {
    const account = byId.get(p.accountId)!;
    const key = JSON.stringify([account.asset, account.decimalScale]);
    const group = groups.get(key) ?? {
      asset: account.asset,
      scale: account.decimalScale,
      debit: 0n,
      credit: 0n,
    };
    if (p.direction === 'DEBIT') group.debit += p.amount;
    else group.credit += p.amount;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.debit !== group.credit) {
      throw new UnbalancedEntryError(group.asset, group.scale, group.debit, group.credit);
    }
  }

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(journalEntries)
      .values({ description: input.description.trim(), coupledPairId: input.coupledPairId ?? null })
      .returning();
    if (!entry) {
      throw new Error('Journal entry insert returned no row.');
    }
    const postingRows = await tx
      .insert(postings)
      .values(
        input.postings.map((p) => ({
          journalEntryId: entry.id,
          accountId: p.accountId,
          direction: p.direction,
          amount: p.amount.toString(),
        })),
      )
      .returning();
    return { entry, postings: postingRows.map(toView) };
  });
}

/** Reads a journal entry and its postings (deterministic order) — the attributable audit view. */
export async function getJournalEntry(
  db: RoseDb,
  id: string,
): Promise<JournalEntryWithPostings | null> {
  const entry = await db.query.journalEntries.findFirst({ where: eq(journalEntries.id, id) });
  if (!entry) {
    return null;
  }
  const rows = await db
    .select()
    .from(postings)
    .where(eq(postings.journalEntryId, id))
    .orderBy(asc(postings.createdAt), asc(postings.id));
  return { entry, postings: rows.map(toView) };
}
