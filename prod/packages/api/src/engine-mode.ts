// Engine-mode reporting (Story 9.6, FR-33). The honest, single source the `GET /mode` route + the
// always-visible web banner read so a visitor is never in doubt about what is REAL vs what is MOCKED.
//
// The mode is DERIVED FROM THE ACTUAL COMPOSITION (not from re-reading `ENGINE_MODE`, not a hardcoded
// guess): `deriveEngineMode` inspects which ports `serve.ts` actually wired into `ApiDeps`, so the
// report can never drift from what the running server really composed.
//   - faithful ⇒ the faithful-only ports are present (the mock KYC registry + the async-confirmation
//     settings store, Stories 9.1/9.2), composed alongside the write services.
//   - paper    ⇒ the write services are composed but WITHOUT the faithful ports (instant auto-confirm,
//     paper-ALLOW authorization — paper's documented shortcuts).
//   - read-only ⇒ no write services composed (the read surfaces still render fully).
//
// SECURITY/HONESTY: the arrays state plainly that NO real capital moves in any mode (testnet/paper),
// and the deployed contracts are untouched (no re-audit). UX-DR4: real vs simulated is never ambiguous.
import type { ApiDeps } from './app.js';
import type { EngineModeInfo } from './schemas.js';

/** The shared "real" line every mode prints — the genuine, non-mocked guarantees. */
const REAL_LEDGER = 'Double-entry ledger + per-(asset, scale) balance invariant';
const REAL_CONTRACTS = 'Deployed coupled-pair contracts (unchanged — no re-audit)';
const REAL_RECONCILE = 'Position ↔ pair reconciliation (residual-backing solvency)';
const REAL_SAGA = 'Outbox/saga commit-point + compensation (no half-applied state)';

/** The mocked externals, by mode. Session identity is the web-side mock (both interactive modes). */
const MOCKED_PRICE_FEED = 'Reference-asset price feed (deterministic replay oracle)';
const MOCKED_SESSION = 'Session identity (mock login / user switcher — no real auth)';

/** REAL in faithful mode (FR-33 AC: ledger, contracts, default-deny gate, reconcile). */
const FAITHFUL_REAL: readonly string[] = [
  REAL_LEDGER,
  REAL_SAGA,
  'Default-deny authorization gate (the real postTransfer chokepoint)',
  REAL_RECONCILE,
  REAL_CONTRACTS,
];

/** MOCKED in faithful mode (FR-33 AC: chain transport latency, KYC issuer, counterparty, price feed). */
const FAITHFUL_MOCKED: readonly string[] = [
  'On-chain confirmation latency + injectable failure (async transport)',
  'KYC/AML claim issuer (mock ONCHAINID onboarding)',
  'Counterparty / inventory model (house re-assignment on single-side close)',
  MOCKED_PRICE_FEED,
  MOCKED_SESSION,
];

/** REAL in paper mode — the same ledger/saga/reconcile/contracts guarantees as faithful. */
const PAPER_REAL: readonly string[] = [REAL_LEDGER, REAL_SAGA, REAL_RECONCILE, REAL_CONTRACTS];

/** MOCKED in paper mode — paper's documented shortcuts (instant confirm, paper-ALLOW authorization). */
const PAPER_MOCKED: readonly string[] = [
  'Instant in-process on-chain confirmation (auto-confirm — no latency, no failure)',
  'Authorization (paper ALLOW — NOT the default-deny gate)',
  'Independent single-side close (fail-closed — no counterparty model)',
  MOCKED_PRICE_FEED,
  MOCKED_SESSION,
];

/** REAL in read-only mode — the read surfaces over the genuine ledger; nothing is mocked. */
const READ_ONLY_REAL: readonly string[] = [
  'Double-entry ledger reads + consolidated group view',
  'Position ↔ pair reconciliation report (read-only)',
  REAL_CONTRACTS,
];

/** Read-only composes NO simulated externals — the write flows simply return a typed 503. */
const READ_ONLY_MOCKED: readonly string[] = [];

/**
 * Whether the faithful-only ports are composed. Faithful mode (`serve.ts`) is the ONLY composition that
 * wires BOTH the mock KYC registry (Story 9.2) and the async-confirmation settings store (Story 9.1);
 * paper composes neither. Requiring both (not either) keeps the detection robust against a future
 * partial composition.
 */
function isFaithfulComposition(deps: ApiDeps): boolean {
  return deps.kycRegistry !== undefined && deps.confirmationSettings !== undefined;
}

/** Whether the interactive write services are composed (true in BOTH paper and faithful). */
function hasWriteServices(deps: ApiDeps): boolean {
  return deps.subscriptions !== undefined || deps.positionService !== undefined;
}

/**
 * Derive the running engine mode + its honest real-vs-mocked summary from the ACTUAL composed
 * dependencies (never a hardcoded guess). Returns a plain, JSON-serialisable `EngineModeInfo`.
 */
export function deriveEngineMode(deps: ApiDeps): EngineModeInfo {
  if (isFaithfulComposition(deps)) {
    return { engineMode: 'faithful', real: [...FAITHFUL_REAL], mocked: [...FAITHFUL_MOCKED] };
  }
  if (hasWriteServices(deps)) {
    return { engineMode: 'paper', real: [...PAPER_REAL], mocked: [...PAPER_MOCKED] };
  }
  return { engineMode: 'read-only', real: [...READ_ONLY_REAL], mocked: [...READ_ONLY_MOCKED] };
}
