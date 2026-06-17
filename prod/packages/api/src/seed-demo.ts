// Demo-data seed for the shared live environment (infrastructure, NOT a BMAD story). Populates JUST
// enough state that the operator screens (Covenant Console / group view, coupled-pair, Rose Note)
// render with content instead of empty tables. IDEMPOTENT: re-running creates no duplicates — every
// write is guarded by an existence check on a deterministic key.
//
// Reuses the existing `@rose/ledger` repository helpers (no new ledger primitive). The four fixed
// entities are already seeded by migration 0001; this adds a representative set of typed accounts,
// one delta-neutral coupled pair, and one Rose Note embedding that pair.
import { pathToFileURL } from 'node:url';
import {
  createAccount,
  createCoupledPair,
  createDb,
  createPool,
  createRoseNote,
  migrateUp,
  type CreateAccountInput,
  type RoseDb,
} from '@rose/ledger';

/** A stable reference asset used as the idempotency key for the demo coupled pair. */
const DEMO_REFERENCE_ASSET = 'DEMO/EUR-USD';

/** Representative typed accounts (each placement is allowed by the FR-1 routing policy). */
const DEMO_ACCOUNTS: readonly CreateAccountInput[] = [
  { entityCode: 'VCC', type: 'BACKING_FLOAT', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'VCC', type: 'CLIENT_COLLATERAL', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'VCC', type: 'NOTE_LIABILITY', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'VCC', type: 'FEE_INCOME', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'TRADING_CO', type: 'DEPLOYED_CAPITAL', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'TRADING_CO', type: 'FEE_INCOME', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'COIN_ISSUER', type: 'BACKING_FLOAT', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'COIN_ISSUER', type: 'DEPLOYED_CAPITAL', asset: 'EUR', decimalScale: 2 },
  { entityCode: 'HOLDING', type: 'FEE_INCOME', asset: 'EUR', decimalScale: 2 },
];

/** Creates the demo accounts that do not already exist (idempotent on entity+type+asset). */
async function seedAccounts(db: RoseDb): Promise<number> {
  const entityRows = await db.query.entities.findMany();
  const codeById = new Map(entityRows.map((e) => [e.id, e.code]));
  const existing = await db.query.accounts.findMany();
  const present = new Set(
    existing.map((a) => `${codeById.get(a.entityId) ?? '?'}:${a.type}:${a.asset}`),
  );

  let created = 0;
  for (const input of DEMO_ACCOUNTS) {
    const key = `${input.entityCode}:${input.type}:${input.asset}`;
    if (present.has(key)) continue;
    await createAccount(db, input);
    created += 1;
  }
  return created;
}

/**
 * Ensures exactly one delta-neutral demo coupled pair (equal long/short legs) exists, with one
 * Rose Note embedding it. Returns the pair id. Idempotent: keyed on the demo reference asset.
 */
async function seedPairAndNote(db: RoseDb): Promise<string> {
  const existingPair = await db.query.coupledPairs.findFirst({
    where: (pair, { eq }) => eq(pair.referenceAsset, DEMO_REFERENCE_ASSET),
  });

  const pairId =
    existingPair?.id ??
    (
      await createCoupledPair(db, {
        referenceAsset: DEMO_REFERENCE_ASSET,
        anchorPrice: '1.10000000',
        leverage: '3',
        collateralPool: 1_000_000_000n,
        floor: '0.50',
        // Equal legs ⇒ delta-neutral at issuance (required by `createRoseNote`).
        longLegValue: 500_000_000n,
        shortLegValue: 500_000_000n,
        state: 'ACTIVE',
      })
    ).id;

  const existingNote = await db.query.roseNotes.findFirst({
    where: (note, { eq: eqOp }) => eqOp(note.coupledPairId, pairId),
  });
  if (!existingNote) {
    await createRoseNote(db, { coupledPairId: pairId });
  }
  return pairId;
}

/** Seeds all demo data against an open `RoseDb` (assumes migrations already applied). */
export async function seedDemoData(
  db: RoseDb,
): Promise<{ pairId: string; accountsCreated: number }> {
  const accountsCreated = await seedAccounts(db);
  const pairId = await seedPairAndNote(db);
  return { pairId, accountsCreated };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('Refusing to seed: DATABASE_URL is not set.');
  }
  const pool = createPool(databaseUrl);
  try {
    console.log('[seed] applying database migrations…');
    await migrateUp(pool);
    const db = createDb(pool);
    const { pairId, accountsCreated } = await seedDemoData(db);
    console.log(
      `[seed] done — demo coupled pair ${pairId} (with Rose Note); ${accountsCreated} new account(s).`,
    );
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[seed] fatal:', err);
    process.exit(1);
  });
}
