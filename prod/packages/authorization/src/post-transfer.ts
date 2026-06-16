// @rose/authorization — the single off-chain capital-movement chokepoint (Story 3.3, FR-7).
//
// `postTransfer` is the ONE function through which every inter-account capital movement flows.
// It builds a rule-spec `TransferScenario` from its typed inputs, consults the substitutable
// `AuthorizationProvider` (Story 3.2) BEFORE any write, and is fail-closed: a `DENY` or `REFUSE`
// decision throws `TransferRefusedError` and writes NOTHING (NFR-4). Only an `ALLOW` records the
// transfer — exactly one balanced journal entry via the Story-1.6 `recordJournalEntry` primitive
// (the DEFERRABLE double-entry trigger, Story 1.5, is the database-level backstop). The provider
// authors zero rules here; the 10 shared conformance vectors (Story 3.1) define the decisions
// this chokepoint obtains and enforces.
import type {
  AccountTypeCode,
  AssetKind,
  Classification,
  ConformanceEnv,
  DestinationKind,
  Effect,
  TransferScenario,
} from '@rose/rule-spec';
import type { JournalEntryWithPostings, RoseExecutor } from '@rose/ledger';
import { recordJournalEntry } from '@rose/ledger';
import { assertNotFloat } from '@rose/shared';
import type { AuthorizationProvider } from './provider/authorization-provider.js';

/**
 * The source endpoint of a transfer: the concrete ledger account being credited (value leaves it)
 * PLUS the logical authorization facts it carries — its account type and Model-A `classification`.
 */
export interface TransferSource {
  readonly accountId: string;
  readonly accountType: AccountTypeCode;
  readonly classification: Classification;
}

/**
 * The destination endpoint: the concrete counter-account being debited (value arrives) PLUS its
 * logical authorization `destinationKind` (`TREASURY | CLIENT_ACCOUNT | EXTERNAL`). The logical
 * kind drives authorization; the concrete `accountId` is where the balancing posting lands — an
 * `EXTERNAL` destination is modeled as a real external/clearing account, so the ledger entry
 * always balances against a real account.
 */
export interface TransferDestination {
  readonly accountId: string;
  readonly destinationKind: DestinationKind;
}

/** A structured audit record of one authorization decision at the chokepoint (NFR-3, CLAUDE.md §11). */
export interface TransferDecisionLog {
  readonly effect: Effect;
  readonly reason: string;
  readonly fromAccountType: AccountTypeCode;
  readonly classification: Classification;
  readonly destinationKind: DestinationKind;
  readonly assetKind: AssetKind;
  /** Smallest-units amount as a decimal string (never a binary float — NFR-2). */
  readonly amount: string;
}

/**
 * Structured logging sink for the chokepoint's decision points. Defaults to a no-op so a library
 * package emits no console noise; the composition layer (api/rose-note, later) injects a real
 * logger. `info` is used for an `ALLOW`, `warn` for a fail-closed `DENY`/`REFUSE`.
 */
export interface TransferLogger {
  info(event: TransferDecisionLog): void;
  warn(event: TransferDecisionLog): void;
}

const NOOP_LOGGER: TransferLogger = {
  info: () => {},
  warn: () => {},
};

/** Everything the chokepoint needs to authorize and (on ALLOW) record one transfer. */
export interface PostTransferContext {
  /** The substitutable authorization seam (Story 3.2). Consulted BEFORE any write. */
  readonly provider: AuthorizationProvider;
  /** The ledger executor — pass an open transaction to compose the transfer inside a larger unit. */
  readonly db: RoseExecutor;
  /** What is moving: economic VALUE vs a TOKEN quantity. */
  readonly assetKind: AssetKind;
  /** True if the flow routes through a VCC account (token/trading flows must not). */
  readonly throughVcc?: boolean;
  /** Floor-config presence/breach env, modeled abstractly (no money float here — NFR-2). */
  readonly env: ConformanceEnv;
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  /** Optional structured logger for the decision points; defaults to no-op. */
  readonly logger?: TransferLogger;
}

/** The persisted result of an authorized transfer. */
export type TransferReceipt = JournalEntryWithPostings;

/** Thrown when the chokepoint is called with a structurally invalid amount (NFR-2). */
export class InvalidTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransferError';
  }
}

/**
 * Thrown when the `AuthorizationProvider` does not return `ALLOW`. Carries the non-allow `effect`
 * (`DENY` vs `REFUSE`, so a later API boundary can map 403 vs 422), the audit `reason`, and the
 * evaluated `scenario`. Its existence guarantees the fail-closed property is observable: when it is
 * thrown, nothing has been written to the ledger.
 */
export class TransferRefusedError extends Error {
  readonly effect: Exclude<Effect, 'ALLOW'>;
  readonly reason: string;
  readonly scenario: TransferScenario;
  constructor(effect: Exclude<Effect, 'ALLOW'>, reason: string, scenario: TransferScenario) {
    super(`Transfer ${effect}: ${reason}`);
    this.name = 'TransferRefusedError';
    this.effect = effect;
    this.reason = reason;
    this.scenario = scenario;
  }
}

/**
 * The single off-chain capital-movement chokepoint (FR-7). Consults the `AuthorizationProvider`
 * BEFORE writing; a non-`ALLOW` decision throws `TransferRefusedError` and writes nothing
 * (fail-closed, NFR-4). On `ALLOW`, records exactly one balanced transfer entry — value leaves
 * `from` (CREDIT) and arrives at `to` (DEBIT) of equal amount on the same asset.
 *
 * @throws InvalidTransferError  for a non-positive / non-bigint amount (NFR-2)
 * @throws TransferRefusedError  for a `DENY` or `REFUSE` decision (nothing written)
 */
export async function postTransfer(
  from: TransferSource,
  to: TransferDestination,
  amount: bigint,
  context: PostTransferContext,
): Promise<TransferReceipt> {
  // 1. Validate the amount FIRST — a JS number/float is never a valid amount (NFR-2), and a
  //    non-positive transfer is meaningless. We reject before consulting the provider or the DB.
  try {
    assertNotFloat(amount);
  } catch {
    throw new InvalidTransferError(
      'Transfer amount must be a bigint in smallest units, never a binary float (NFR-2).',
    );
  }
  if (typeof amount !== 'bigint') {
    throw new InvalidTransferError('Transfer amount must be a bigint in smallest units.');
  }
  if (amount <= 0n) {
    throw new InvalidTransferError('Transfer amount must be a positive integer.');
  }
  // A transfer moves value BETWEEN two accounts; from===to would net to a phantom no-op entry that
  // balances trivially against one account. Reject it before consulting the provider or the DB.
  if (from.accountId === to.accountId) {
    throw new InvalidTransferError(
      'A transfer must move value between two distinct accounts (from and to are the same account).',
    );
  }

  // 2. Build the authorization request from the typed inputs (the SAME shape the Story-3.2
  //    `AuthorizationRequest` and the Story-3.1 conformance harness drive — no field re-mapping).
  const scenario: TransferScenario = {
    from: from.accountType,
    classification: from.classification,
    to: to.destinationKind,
    assetKind: context.assetKind,
    throughVcc: context.throughVcc,
  };

  // 3. Consult authorization BEFORE any write. The provider returns a decision; it never throws
  //    on a DENY/REFUSE (Story 3.2 contract), so no try/catch is needed around it.
  const decision = context.provider.authorize({ scenario, env: context.env });

  const logger = context.logger ?? NOOP_LOGGER;
  const log: TransferDecisionLog = {
    effect: decision.effect,
    reason: decision.reason,
    fromAccountType: from.accountType,
    classification: from.classification,
    destinationKind: to.destinationKind,
    assetKind: context.assetKind,
    amount: amount.toString(),
  };

  // 4. Fail-closed: anything that is not an explicit ALLOW writes NOTHING.
  if (decision.effect !== 'ALLOW') {
    logger.warn(log);
    throw new TransferRefusedError(decision.effect, decision.reason, scenario);
  }

  // 5. ALLOW is the ONLY path to a write — record exactly one balanced transfer entry. Value
  //    leaves `from` (CREDIT) and arrives at `to` (DEBIT); the ledger enforces per-(asset,scale)
  //    balance and the DEFERRABLE double-entry trigger is the DB-level backstop. (If `from` and
  //    `to` are different assets/scales the ledger rejects the unbalanced entry and nothing
  //    persists — fail-safe.)
  const receipt = await recordJournalEntry(context.db, {
    description: context.description,
    postings: [
      { accountId: from.accountId, direction: 'CREDIT', amount },
      { accountId: to.accountId, direction: 'DEBIT', amount },
    ],
  });
  // Audit the ALLOW only AFTER the write commits, so an "allowed" INFO record never overstates a
  // transfer that failed to persist (NFR-3 accuracy).
  logger.info(log);
  return receipt;
}
