// Account repository — enforces the routing rule on placement (FR-1). There is intentionally
// NO createEntity: the four entities are fixed and seeded by the migration ("no API path
// creates entities dynamically").
import { eq } from 'drizzle-orm';
import type { RoseDb } from '../db.js';
import { accounts, entities } from '../schema/index.js';
import type { Account, AccountType, EntityCode } from '../schema/index.js';

/**
 * P0 routing policy — the explicit interpretation of FR-1's high-level rule
 * (VCC = cash/NAV only; exchange accounts under TRADING_CO; coin treasury / on-chain
 * liquidity under COIN_ISSUER). Kept as one reviewable map; refine as product specifies.
 */
export const ENTITY_ALLOWED_ACCOUNT_TYPES: Readonly<Record<EntityCode, readonly AccountType[]>> =
  Object.freeze({
    // Cash/NAV at the regulated issuer — no deployed positions.
    VCC: ['BACKING_FLOAT', 'CLIENT_COLLATERAL', 'FEE_INCOME', 'NOTE_LIABILITY'],
    // Holding company — receives fee/dividend income only.
    HOLDING: ['FEE_INCOME'],
    // Exchange / trading — deployed capital and trading fee income.
    TRADING_CO: ['DEPLOYED_CAPITAL', 'FEE_INCOME'],
    // Coin treasury / on-chain liquidity.
    COIN_ISSUER: ['BACKING_FLOAT', 'DEPLOYED_CAPITAL'],
  });

/** Thrown when an account placement violates the routing rule. */
export class AccountPlacementError extends Error {
  readonly entityCode: EntityCode;
  readonly accountType: AccountType;
  constructor(entityCode: EntityCode, accountType: AccountType) {
    super(
      `Routing rule violation: account type '${accountType}' is not permitted under entity '${entityCode}'.`,
    );
    this.name = 'AccountPlacementError';
    this.entityCode = entityCode;
    this.accountType = accountType;
  }
}

/** Returns true if `type` may be placed under `entityCode` per the P0 routing policy. */
export function isPlacementAllowed(entityCode: EntityCode, type: AccountType): boolean {
  return ENTITY_ALLOWED_ACCOUNT_TYPES[entityCode]?.includes(type) ?? false;
}

// smallint upper bound; decimal scales never approach this, but bound it explicitly.
const MAX_DECIMAL_SCALE = 32767;

/** Validates `decimalScale` is a non-negative integer in range, with a typed domain error. */
export function assertValidDecimalScale(decimalScale: number): void {
  if (!Number.isInteger(decimalScale) || decimalScale < 0 || decimalScale > MAX_DECIMAL_SCALE) {
    throw new RangeError(
      `Invalid decimal scale '${decimalScale}': expected an integer in [0, ${MAX_DECIMAL_SCALE}].`,
    );
  }
}

export interface CreateAccountInput {
  readonly entityCode: EntityCode;
  readonly type: AccountType;
  readonly asset: string;
  readonly decimalScale: number;
}

/** Creates an account under the named entity, enforcing the routing rule. */
export async function createAccount(db: RoseDb, input: CreateAccountInput): Promise<Account> {
  if (!isPlacementAllowed(input.entityCode, input.type)) {
    throw new AccountPlacementError(input.entityCode, input.type);
  }
  // Validate scale as a domain error before it reaches the DB (a JS float like 2.5 would
  // otherwise surface as a raw pg error, and is one cast-path from silent rounding).
  assertValidDecimalScale(input.decimalScale);
  const entity = await db.query.entities.findFirst({
    where: eq(entities.code, input.entityCode),
  });
  if (!entity) {
    throw new Error(`Entity '${input.entityCode}' not found (database not migrated/seeded?).`);
  }
  const [row] = await db
    .insert(accounts)
    .values({
      entityId: entity.id,
      type: input.type,
      asset: input.asset,
      decimalScale: input.decimalScale,
    })
    .returning();
  if (!row) {
    throw new Error('Account insert returned no row.');
  }
  return row;
}
