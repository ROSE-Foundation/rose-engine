// @rose/authorization — bind authorization facts to PERSISTED account state (Story 3.4).
//
// Story 3.3 left a documented trust boundary: `postTransfer` took `accountType` as a caller-supplied
// fact. Here we resolve and VALIDATE it against the real `accounts` row, and read the account's
// current balance in NUMERIC for the floor computation. No binary float ever appears (NFR-2): the
// balance is summed in Postgres NUMERIC and parsed straight to `bigint`.
import { eq, sql } from 'drizzle-orm';
import type { RoseExecutor } from '@rose/ledger';
import { accounts, postings } from '@rose/ledger';
import type { AccountTypeCode } from '@rose/rule-spec';

/** Thrown when a declared `accountType` does not match the persisted account row — fail-closed. */
export class AccountFactMismatchError extends Error {
  readonly accountId: string;
  readonly declaredType: AccountTypeCode;
  readonly persistedType: AccountTypeCode;
  constructor(accountId: string, declaredType: AccountTypeCode, persistedType: AccountTypeCode) {
    super(
      `Authorization fact mismatch for account '${accountId}': caller declared accountType ` +
        `'${declaredType}' but the persisted account is '${persistedType}'. Refusing (NFR-4).`,
    );
    this.name = 'AccountFactMismatchError';
    this.accountId = accountId;
    this.declaredType = declaredType;
    this.persistedType = persistedType;
  }
}

/** Thrown when an account id has no persisted row — the transfer source must exist. */
export class AccountNotFoundError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`Account '${accountId}' not found (database not migrated/seeded?).`);
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
  }
}

/** The persisted facts an authorization decision derives from the source account row. */
export interface PersistedAccountFacts {
  readonly accountId: string;
  readonly type: AccountTypeCode;
  readonly asset: string;
  readonly decimalScale: number;
}

/** Read the persisted `(type, asset, decimal_scale)` for an account; throws if it does not exist. */
export async function loadAccountFacts(
  executor: RoseExecutor,
  accountId: string,
): Promise<PersistedAccountFacts> {
  const rows = await executor
    .select({ type: accounts.type, asset: accounts.asset, scale: accounts.decimalScale })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const row = rows[0];
  if (!row) {
    throw new AccountNotFoundError(accountId);
  }
  return { accountId, type: row.type, asset: row.asset, decimalScale: row.scale };
}

/** Assert the declared account type matches the persisted facts; throws `AccountFactMismatchError`. */
export function assertAccountTypeMatches(
  facts: PersistedAccountFacts,
  declaredType: AccountTypeCode,
): void {
  if (facts.type !== declaredType) {
    throw new AccountFactMismatchError(facts.accountId, declaredType, facts.type);
  }
}

/**
 * The current balance of an account in smallest units, as an exact `bigint`. Computed in Postgres
 * NUMERIC: a DEBIT adds value, a CREDIT removes it (the same direction convention `postTransfer`
 * uses — value leaves `from` as a CREDIT). No row ⇒ 0. NEVER uses a binary float (NFR-2).
 */
export async function readAccountBalance(
  executor: RoseExecutor,
  accountId: string,
): Promise<bigint> {
  const rows = await executor
    .select({
      balance: sql<string>`COALESCE(SUM(CASE WHEN ${postings.direction} = 'DEBIT' THEN ${postings.amount} ELSE -${postings.amount} END), 0)`,
    })
    .from(postings)
    .where(eq(postings.accountId, accountId));
  const raw = rows[0]?.balance ?? '0';
  // The postings invariant keeps amounts integral; refuse a non-integer balance rather than risk a
  // lossy BigInt() throw masking a precision bug (NFR-2).
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Account '${accountId}' has a non-integer NUMERIC balance '${raw}' (NFR-2).`);
  }
  return BigInt(raw);
}
