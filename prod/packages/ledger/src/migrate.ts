// Migration runner with forward AND down support (NFR-5: reversible from the first commit).
// drizzle-kit only generates forward migrations, so this runner — applying hand-written
// up/down SQL pairs and tracking state in `schema_migrations` — is what realizes
// reversibility. Each migration runs in its own transaction (DDL is transactional in PG),
// and the whole run is serialized by a session-level advisory lock so concurrent runners
// (e.g. multi-instance startup) cannot race.
import type pg from 'pg';
import { MIGRATIONS } from './migrations/index.js';

export interface Migration {
  readonly version: string;
  readonly up: string;
  readonly down: string;
}

const ENSURE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

// Arbitrary fixed key identifying the migration advisory lock.
const MIGRATION_ADVISORY_LOCK_KEY = 911_911;

async function appliedVersions(pool: pg.Pool): Promise<Set<string>> {
  await pool.query(ENSURE_TRACKING_TABLE);
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

/** Migrations sorted by version, so apply/rollback order is independent of array insertion order. */
function sortedByVersion(migrations: readonly Migration[]): Migration[] {
  return [...migrations].sort((a, b) =>
    a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
  );
}

/** Runs `fn` while holding a session-level advisory lock, serializing concurrent runners. */
async function withMigrationLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

/** Runs a migration body + its tracking change in one transaction, preserving the root error. */
async function runMigrationTx(
  pool: pg.Pool,
  sql: string,
  trackQuery: string,
  trackParams: unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(trackQuery, trackParams);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error even if ROLLBACK itself fails (e.g. a dead connection).
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Applies all pending migrations in version order. Returns the versions newly applied. */
export async function migrateUp(
  pool: pg.Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  return withMigrationLock(pool, async () => {
    const applied = await appliedVersions(pool);
    const newlyApplied: string[] = [];
    for (const migration of sortedByVersion(migrations)) {
      if (applied.has(migration.version)) continue;
      await runMigrationTx(
        pool,
        migration.up,
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [migration.version],
      );
      newlyApplied.push(migration.version);
    }
    return newlyApplied;
  });
}

/** Rolls back the last `steps` applied migrations (default 1). Returns the versions rolled back. */
export async function migrateDown(
  pool: pg.Pool,
  steps = 1,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RangeError(`migrateDown steps must be a non-negative integer, got '${steps}'.`);
  }
  return withMigrationLock(pool, async () => {
    await pool.query(ENSURE_TRACKING_TABLE);
    const { rows } = await pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC',
    );
    const toRollback = rows.slice(0, steps).map((r) => r.version);
    const rolledBack: string[] = [];
    for (const version of toRollback) {
      const migration = migrations.find((m) => m.version === version);
      if (!migration) {
        throw new Error(`No migration definition found for applied version '${version}'.`);
      }
      await runMigrationTx(
        pool,
        migration.down,
        'DELETE FROM schema_migrations WHERE version = $1',
        [version],
      );
      rolledBack.push(version);
    }
    return rolledBack;
  });
}

/**
 * Defensive teardown for tests/CI: runs every migration's `down` (IF EXISTS-safe) in reverse
 * version order and drops the tracking table, returning the database to a clean baseline
 * regardless of any partially-applied state from a previous crashed run.
 */
export async function hardReset(
  pool: pg.Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  for (const migration of sortedByVersion(migrations).reverse()) {
    await pool.query(migration.down);
  }
  await pool.query('DROP TABLE IF EXISTS schema_migrations');
}
