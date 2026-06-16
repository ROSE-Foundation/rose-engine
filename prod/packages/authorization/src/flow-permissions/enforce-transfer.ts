// @rose/authorization — wire the DB-backed provider + persisted-state binding into the chokepoint
// (Story 3.4). This is the production entry point for an off-chain capital movement: it resolves
// and validates the source account's facts against the DB, derives the floor-guard env (floor from
// `@rose/config`, post-balance in NUMERIC), then calls the UNCHANGED `postTransfer` chokepoint with
// the DB-backed provider. The chokepoint itself is untouched — substitutability does all the work
// (NFR-8).
import type { RoseConfig } from '@rose/config';
import type { RoseExecutor } from '@rose/ledger';
import type { AssetKind, ConformanceEnv } from '@rose/rule-spec';
import type { AuthorizationProvider } from '../provider/authorization-provider.js';
import {
  postTransfer,
  type TransferDestination,
  type TransferLogger,
  type TransferReceipt,
  type TransferSource,
} from '../post-transfer.js';
import { assertAccountTypeMatches, loadAccountFacts } from './account-state.js';
import { backingFloatFloorFrom, resolveOffChainEnv } from './resolve-env.js';

/** Everything `enforceTransfer` needs beyond the from/to/amount of the movement. */
export interface EnforceTransferContext {
  /** The DB-backed authorization provider (`loadDbOffChainPolicyProvider`). */
  readonly provider: AuthorizationProvider;
  /** The ledger executor (a pooled db or an open transaction). */
  readonly db: RoseExecutor;
  /** What is moving: economic VALUE vs a TOKEN quantity. */
  readonly assetKind: AssetKind;
  /** True if the flow routes through a VCC account (token/trading flows must not). */
  readonly throughVcc?: boolean;
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  /** Optional structured logger for the decision points; defaults to no-op inside `postTransfer`. */
  readonly logger?: TransferLogger;
  /** Loaded parked config; its `backingFloatFloor` resolves the floor (absent ⇒ REFUSE). */
  readonly config?: Pick<RoseConfig, 'backingFloatFloor'>;
}

/**
 * Authorize and (on ALLOW) record one transfer through the single chokepoint, binding the
 * authorization facts to persisted state:
 *  1. Validate the declared `from.accountType` against the persisted `accounts` row (fail-closed).
 *  2. Derive the floor-guard `ConformanceEnv` from the DB balance + `@rose/config` floor (NUMERIC).
 *  3. Delegate to `postTransfer` (UNCHANGED) with the DB-backed provider and the derived env.
 *
 * Amount validation (positive, non-float) is owned by `postTransfer`; when the amount is structurally
 * invalid we skip the DB derivation and let the chokepoint reject it with `InvalidTransferError`.
 */
export async function enforceTransfer(
  from: TransferSource,
  to: TransferDestination,
  amount: bigint,
  context: EnforceTransferContext,
): Promise<TransferReceipt> {
  let env: ConformanceEnv = {};

  // Only derive DB-bound facts for a structurally valid amount; an invalid amount is rejected by
  // the chokepoint before it ever consults the provider, so the env is irrelevant in that case.
  if (typeof amount === 'bigint' && amount > 0n) {
    const facts = await loadAccountFacts(context.db, from.accountId);
    // Bind the SOURCE account type to persisted state (resolves the Story-3.3 deferral for the
    // source). TRUST BOUNDARY (documented P0 residual): `from.classification` and `to.destinationKind`
    // remain caller-asserted facts — neither is a persisted column in P0 (the `accounts` row exposes
    // only type/asset/decimal_scale, and there is no account→destinationKind mapping). They are
    // load-bearing for the Model-A prohibition and the destination match, so the AUTHORITATIVE
    // off-chain enforcement of the principal/yield distinction is deferred to Epic 4 (segregated
    // principal sub-positions on-chain). See _bmad-output/implementation-artifacts/deferred-work.md.
    assertAccountTypeMatches(facts, from.accountType);
    env = await resolveOffChainEnv({
      executor: context.db,
      facts,
      amount,
      backingFloatFloorDecimal: backingFloatFloorFrom(context.config),
    });
  }

  return postTransfer(from, to, amount, {
    provider: context.provider,
    db: context.db,
    assetKind: context.assetKind,
    throughVcc: context.throughVcc,
    env,
    description: context.description,
    logger: context.logger,
  });
}
