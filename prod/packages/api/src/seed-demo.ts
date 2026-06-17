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
  recordJournalEntry,
  type CreateAccountInput,
  type RoseDb,
} from '@rose/ledger';
import type { PaperModeConfig } from '@rose/rose-note';

/** A stable reference asset used as the idempotency key for the demo coupled pair. */
const DEMO_REFERENCE_ASSET = 'DEMO/EUR-USD';

// ─── Paper-mode demo constants (infrastructure; non-secret) ──────────────────────────────────────

/** The single payment asset the paper P0 flows are denominated in. */
const PAPER_PAYMENT_ASSET = 'EUR';
/** The curated allowlist-eligible subscriber address for the demo (FR-19 analogue). */
const PAPER_ELIGIBLE_SUBSCRIBER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The holder whose paired legs a strategy reset retires in the demo. */
const PAPER_POSITION_HOLDER = PAPER_ELIGIBLE_SUBSCRIBER;
/** Parked floor m/g the reset threshold derives from (paper demo values, non-secret). */
const PAPER_FLOOR = { modelFloorM: '0.5', modelFloorG: '0.4' } as const;
/** A pre-existing minted position seeded on each token leg so redemptions / resets have supply to retire. */
const PAPER_INITIAL_POSITION = 1_000_000_000n;

/**
 * The ROSE_L / ROSE_S token-leg accounts the paper mint/burn legs post against (scale 0 token
 * quantities): ASSET-classified holders + NON-ASSET supply contras (mirrors the proven 6.x topology).
 */
const PAPER_TOKEN_ACCOUNTS: readonly CreateAccountInput[] = [
  { entityCode: 'COIN_ISSUER', type: 'BACKING_FLOAT', asset: 'ROSE_L', decimalScale: 0 },
  { entityCode: 'VCC', type: 'NOTE_LIABILITY', asset: 'ROSE_L', decimalScale: 0 },
  { entityCode: 'COIN_ISSUER', type: 'BACKING_FLOAT', asset: 'ROSE_S', decimalScale: 0 },
  { entityCode: 'VCC', type: 'CLIENT_COLLATERAL', asset: 'ROSE_S', decimalScale: 0 },
];

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

/** Creates the given accounts that do not already exist (idempotent on entity+type+asset). */
async function seedAccounts(
  db: RoseDb,
  accounts: readonly CreateAccountInput[] = DEMO_ACCOUNTS,
): Promise<number> {
  const entityRows = await db.query.entities.findMany();
  const codeById = new Map(entityRows.map((e) => [e.id, e.code]));
  const existing = await db.query.accounts.findMany();
  const present = new Set(
    existing.map((a) => `${codeById.get(a.entityId) ?? '?'}:${a.type}:${a.asset}`),
  );

  let created = 0;
  for (const input of accounts) {
    const key = `${input.entityCode}:${input.type}:${input.asset}`;
    if (present.has(key)) continue;
    await createAccount(db, input);
    created += 1;
  }
  return created;
}

/** Builds an `entityCode:type:asset → accountId` index for resolving the paper-mode topologies. */
async function accountIndex(db: RoseDb): Promise<Map<string, string>> {
  const entityRows = await db.query.entities.findMany();
  const codeById = new Map(entityRows.map((e) => [e.id, e.code]));
  const accounts = await db.query.accounts.findMany();
  const index = new Map<string, string>();
  for (const a of accounts) {
    index.set(`${codeById.get(a.entityId) ?? '?'}:${a.type}:${a.asset}`, a.id);
  }
  return index;
}

/** Resolves a seeded account id; throws (fail-closed) if an expected demo account is missing. */
function idOf(index: Map<string, string>, entityCode: string, type: string, asset: string): string {
  const id = index.get(`${entityCode}:${type}:${asset}`);
  if (id === undefined) {
    throw new Error(`[seed] expected demo account ${entityCode}:${type}:${asset} to exist.`);
  }
  return id;
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

/**
 * Seeds a pre-existing minted position (PAPER_INITIAL_POSITION per leg) so redemptions and strategy
 * resets have supply + a NOTE_LIABILITY balance to retire. Idempotent: skips if the pair already has
 * any journal entry (a prior seed run, or a confirmed subscription, already established a position).
 */
async function seedInitialPosition(
  db: RoseDb,
  pairId: string,
  topology: PaperModeConfig['subscriptionTopology'],
): Promise<boolean> {
  const existing = await db.query.journalEntries.findFirst({
    where: (je, { eq }) => eq(je.coupledPairId, pairId),
  });
  if (existing) return false;
  await recordJournalEntry(db, {
    description: 'paper-mode seed — pre-existing minted position (demo fixture)',
    coupledPairId: pairId,
    postings: [
      {
        accountId: topology.longLegHolderAccountId,
        direction: 'DEBIT',
        amount: PAPER_INITIAL_POSITION,
      },
      {
        accountId: topology.longLegSupplyAccountId,
        direction: 'CREDIT',
        amount: PAPER_INITIAL_POSITION,
      },
      {
        accountId: topology.shortLegHolderAccountId,
        direction: 'DEBIT',
        amount: PAPER_INITIAL_POSITION,
      },
      {
        accountId: topology.shortLegSupplyAccountId,
        direction: 'CREDIT',
        amount: PAPER_INITIAL_POSITION,
      },
      { accountId: topology.cashAccountId, direction: 'DEBIT', amount: PAPER_INITIAL_POSITION },
      {
        accountId: topology.noteLiabilityAccountId,
        direction: 'CREDIT',
        amount: PAPER_INITIAL_POSITION,
      },
    ],
  });
  return true;
}

/**
 * Seeds everything the PAPER-MODE write flows need and returns the resolved composition config (the
 * `PaperModeConfig` minus `db`): the demo coupled pair / Rose Note, the EUR + ROSE_L/ROSE_S typed
 * accounts, an initial minted position to redeem/reset against, the eligible-subscriber allowlist, and
 * the parked floor. Idempotent — safe to run on every boot. NO secret.
 */
export async function seedPaperDemo(db: RoseDb): Promise<Omit<PaperModeConfig, 'db'>> {
  await seedAccounts(db, DEMO_ACCOUNTS);
  await seedAccounts(db, PAPER_TOKEN_ACCOUNTS);
  const pairId = await seedPairAndNote(db);

  const index = await accountIndex(db);
  const lHolder = idOf(index, 'COIN_ISSUER', 'BACKING_FLOAT', 'ROSE_L');
  const lSupply = idOf(index, 'VCC', 'NOTE_LIABILITY', 'ROSE_L');
  const sHolder = idOf(index, 'COIN_ISSUER', 'BACKING_FLOAT', 'ROSE_S');
  const sSupply = idOf(index, 'VCC', 'CLIENT_COLLATERAL', 'ROSE_S');
  const cash = idOf(index, 'VCC', 'BACKING_FLOAT', PAPER_PAYMENT_ASSET);
  const noteLiab = idOf(index, 'VCC', 'NOTE_LIABILITY', PAPER_PAYMENT_ASSET);
  const tcoDeployed = idOf(index, 'TRADING_CO', 'DEPLOYED_CAPITAL', PAPER_PAYMENT_ASSET);
  const tcoIncome = idOf(index, 'TRADING_CO', 'FEE_INCOME', PAPER_PAYMENT_ASSET);

  const subscriptionTopology = {
    longLegHolderAccountId: lHolder,
    longLegSupplyAccountId: lSupply,
    shortLegHolderAccountId: sHolder,
    shortLegSupplyAccountId: sSupply,
    cashAccountId: cash,
    noteLiabilityAccountId: noteLiab,
  };
  const redemptionTopology = subscriptionTopology;
  const strategyTopology = {
    longLegHolderAccountId: lHolder,
    longLegSupplyAccountId: lSupply,
    shortLegHolderAccountId: sHolder,
    shortLegSupplyAccountId: sSupply,
    tradingPnlAssetAccountId: tcoDeployed,
    tradingPnlIncomeAccountId: tcoIncome,
  };

  await seedInitialPosition(db, pairId, subscriptionTopology);

  return {
    subscriptionTopology,
    redemptionTopology,
    strategyTopology,
    eligibleSubscribers: [PAPER_ELIGIBLE_SUBSCRIBER],
    paymentAsset: PAPER_PAYMENT_ASSET,
    positionHolder: PAPER_POSITION_HOLDER,
    floor: PAPER_FLOOR,
  };
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
