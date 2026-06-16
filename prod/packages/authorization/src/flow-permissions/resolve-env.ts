// @rose/authorization — resolve the floor-guard environment from persisted state (Story 3.4).
//
// Builds the `ConformanceEnv` the reference adapter consumes for a floor-guarded flow, deriving
// the floor from `@rose/config` (`backing_float.floor`) and `postBalanceBelowFloor` from the
// account's persisted NUMERIC balance. The reference adapter then maps this env to the decision:
//   - floor config ABSENT  ⇒ backingFloatFloor undefined ⇒ REFUSE (never assume 0, NFR-4)
//   - post-balance below floor ⇒ postBalanceBelowFloor true ⇒ DENY
//   - otherwise ⇒ the matched allow-rule permits the flow.
// All money arithmetic is exact integer/`bigint`; no binary float (NFR-2).
import type { RoseConfig } from '@rose/config';
import type { ConformanceEnv } from '@rose/rule-spec';
import { fromDecimalString } from '@rose/shared';
import { readAccountBalance, type PersistedAccountFacts } from './account-state.js';
import type { RoseExecutor } from '@rose/ledger';

/**
 * Extract the `backing_float.floor` decimal string from a loaded `@rose/config`, or `undefined`
 * when no config is available (an unconfigured floor ⇒ REFUSE, never a default of 0).
 */
export function backingFloatFloorFrom(
  config: Pick<RoseConfig, 'backingFloatFloor'> | undefined,
): string | undefined {
  return config?.backingFloatFloor;
}

export interface ResolveEnvInput {
  readonly executor: RoseExecutor;
  /** The persisted facts of the SOURCE account (value leaves it). */
  readonly facts: PersistedAccountFacts;
  /** Smallest-units transfer amount; subtracted from the source balance to get the post-balance. */
  readonly amount: bigint;
  /** `backing_float.floor` as a decimal string (from @rose/config); undefined ⇒ floor config absent. */
  readonly backingFloatFloorDecimal?: string;
}

/**
 * Resolve the `ConformanceEnv` for a transfer out of the given source account. The floor guard
 * applies ONLY to a `BACKING_FLOAT` egress (the single floor-guarded allow-rule), so for any other
 * source type the env is empty (no floor fields) and the adapter decides on rules alone. For a
 * `BACKING_FLOAT` source: an absent floor yields an empty env (⇒ REFUSE); otherwise the floor is
 * parsed to smallest units and compared against the post-transfer balance, all in exact integers.
 */
export async function resolveOffChainEnv(input: ResolveEnvInput): Promise<ConformanceEnv> {
  const { executor, facts, amount, backingFloatFloorDecimal } = input;

  if (facts.type !== 'BACKING_FLOAT') {
    return {};
  }
  if (backingFloatFloorDecimal === undefined) {
    // Floor config absent ⇒ leave backingFloatFloor undefined ⇒ the adapter REFUSES (NFR-4).
    return {};
  }

  const floor = fromDecimalString(facts.asset, backingFloatFloorDecimal, facts.decimalScale).amount;
  // A negative floor is not a usable protection threshold: with `postBalance < floor` it would be
  // satisfied even by draining the float to zero (or below), silently nullifying the guard. Treat a
  // misconfigured negative floor as "no usable floor" ⇒ REFUSE (fail-closed, NFR-4) — never a
  // permissive ALLOW. (A configured 0 is left intact: it is a deliberate, internally-consistent
  // threshold, distinct from an ABSENT floor.)
  if (floor < 0n) {
    return {};
  }
  const balance = await readAccountBalance(executor, facts.accountId);
  const postBalance = balance - amount;
  return { backingFloatFloor: floor, postBalanceBelowFloor: postBalance < floor };
}
