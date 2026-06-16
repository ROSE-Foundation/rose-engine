// Database connection helpers. Reads DATABASE_URL; defaults to the local docker Postgres on
// host port 5544 (see docker-compose.yml). CI sets DATABASE_URL to its own postgres service.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

const DEFAULT_LOCAL_DATABASE_URL = 'postgres://rose:rose@localhost:5544/rose_engine';

export function getDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;
}

export function createPool(connectionString: string = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString });
}

export type RoseDb = ReturnType<typeof createDb>;

/**
 * A drizzle transaction handle for the ledger schema — the value passed to a
 * `db.transaction(async (tx) => …)` callback. It is NOT type-assignable to `RoseDb`
 * (it lacks `$client`), so composing repo functions across one transaction needs the
 * `RoseExecutor` union below.
 */
export type RoseTransaction = Parameters<Parameters<RoseDb['transaction']>[0]>[0];

/**
 * Anything that can execute ledger statements: a pooled `RoseDb` OR an in-flight
 * transaction handle. Repo functions take a `RoseExecutor` so a caller can run several of
 * them inside ONE `db.transaction(...)` (atomic composition); a plain `RoseDb` still
 * satisfies it, so existing callers are unaffected.
 */
export type RoseExecutor = RoseDb | RoseTransaction;

/** A typed Drizzle client over a pg pool, with the ledger schema attached. */
export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
