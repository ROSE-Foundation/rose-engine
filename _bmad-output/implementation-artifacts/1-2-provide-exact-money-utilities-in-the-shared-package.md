---
baseline_commit: NO_VCS
---

# Story 1.2: Provide exact-money utilities in the shared package

Status: done

## Story

As a build engineer,
I want integer-smallest-unit money helpers with per-asset decimal scale and a deterministic rounding policy,
so that every PROD module represents money exactly and never uses binary float (NFR-2).

## Acceptance Criteria

**AC-1 — Money is an integer in smallest units with its asset's decimal scale**
**Given** the `shared` package
**When** I represent a monetary amount
**Then** it is stored as a `BigInt` integer in the smallest unit of its asset, with the asset's decimal scale available (EUR=2, BTC=8, token=`decimals()`)
**And** any attempt to construct an amount from a binary float is rejected at the boundary

**AC-2 — Deterministic remainder policy preserves totals exactly, serialized as decimal strings**
**Given** a fractional intermediate such as `K/2` or `L·r`
**When** I apply the deterministic remainder/rounding policy (one leg absorbs the residual unit)
**Then** the posted integer amounts preserve `V_A + V_B = K` exactly
**And** the helpers serialize money as decimal strings (never JS `number`) for transport

## Tasks / Subtasks

- [x] **Task 1 — Money type + asset scales (AC: 1)**
  - [x] `prod/packages/shared/src/money.ts`: `Money` = `{ asset: string; scale: number; amount: bigint }` (readonly). Amount is integer smallest-units; scale is the asset's decimal places.
  - [x] `KNOWN_ASSET_SCALES` constant (`EUR: 2`, `BTC: 8`). `knownScaleOf(asset)` returns the scale; throws an explicit error for an unknown asset (tokens supply their scale dynamically via `decimals()`, so callers pass it explicitly — never guess/default).
  - [x] `money(asset, amount: bigint, scale?)` constructor: validates `amount` is a `bigint`, `scale` is a non-negative safe integer; uses `knownScaleOf(asset)` when `scale` omitted.
- [x] **Task 2 — Reject binary float at the boundary (AC: 1)**
  - [x] `assertNotFloat(value)`: throws a typed error if `value` is a JS `number` (binary float prohibited in PROD — NFR-2), with a message pointing callers to `fromDecimalString`. Used wherever external/untyped input could carry a number.
  - [x] The `money()` constructor and all parse paths reject `number` inputs for the amount.
- [x] **Task 3 — Decimal-string (de)serialization (AC: 1, 2)**
  - [x] `fromDecimalString(asset, value: string, scale?)`: parse a decimal string (e.g. `"12.34"`) into a `Money` with `amount` in smallest units. Reject: non-numeric strings, more fractional digits than `scale`, `NaN`/`Infinity`/empty, and any non-string input. Handle optional sign and absent fractional part.
  - [x] `toDecimalString(m: Money): string`: format `amount`+`scale` back to a canonical decimal string (no float), correct for negatives and scale 0.
  - [x] Round-trip property: `fromDecimalString(asset, toDecimalString(m)) deep-equals m` for representable values.
- [x] **Task 4 — Exact arithmetic + deterministic allocation (AC: 2)**
  - [x] `addMoney(a, b)` / `subMoney(a, b)` / `negateMoney(a)`: require identical `asset` and `scale`; throw on mismatch; pure BigInt math.
  - [x] `allocate(total: bigint, weights: bigint[]): bigint[]` — largest-remainder (Hamilton) method: floor each share, then hand out the leftover units to the largest remainders with a deterministic index tie-break. **Guarantees `Σ result === total`** for any non-negative weights with positive sum.
  - [x] `splitInTwo(total: bigint): [bigint, bigint]` = `allocate(total, [1n, 1n])` — the canonical "one leg absorbs the residual unit" split; the two parts always sum to `total` (the `V_A + V_B = K` primitive).
- [x] **Task 5 — Public surface + tests (AC: 1, 2)**
  - [x] Re-export the money API from `prod/packages/shared/src/index.ts`.
  - [x] Co-located `money.test.ts` (Vitest) covering: bigint storage + scale lookup; unknown-asset refusal; float rejection (`assertNotFloat`, constructor, parser); decimal-string round-trips incl. negatives/zero-scale/leading-zero fractional; arithmetic asset/scale-mismatch guards; `allocate`/`splitInTwo` sum-preservation incl. odd totals, multi-weight, large 18-decimal token magnitudes (`bigint` beyond `Number.MAX_SAFE_INTEGER`).
- [x] **Task 6 — Verification gate (AC: 1, 2)**
  - [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:regime` all green.

## Dev Notes

### Scope
- IS: pure exact-money primitives in `shared`. IS NOT: account/asset persistence (Story 1.4), config (Story 1.3), coupled-pair leg math `V_A=(K/2)(1+L·r)` (Epic 2 / throwaway Epic 7). This story provides the **primitives** those stories build on — notably the sum-preserving `allocate`/`splitInTwo`.

### Architecture constraints (authoritative)
[Source: architecture.md#Data Architecture, NFR-2]
- Monetary amounts are **integers in the smallest unit**; **binary float prohibited in PROD**. TypeScript: native **`BigInt`**. Each asset carries its **decimal scale** (EUR=2, BTC=8, token=`decimals()`).
- A **deterministic remainder/rounding policy** (one leg absorbs the residual unit) preserves `V_A + V_B = K` exactly within the barrier. Model math may compute at higher precision, but **postings stay exact integers**.
- Money **in transit** serialized as **decimal strings** in JSON — never JS `number`, never binary float; each carries/references its `decimalScale`. Reject any float amount at the boundary.
  [Source: architecture.md#Format Patterns]

### Naming / structure (from Story 1.1 + architecture)
[Source: architecture.md#Naming Patterns, #Structure Patterns]
- Files `kebab-case.ts`; types `PascalCase`; functions/vars `camelCase`; constants `UPPER_SNAKE_CASE`. ESM, `strict`, `verbatimModuleSyntax` (use `import type` for type-only imports). Tests co-located `*.test.ts` (Vitest, run from repo root; resolves `vitest` via upward `node_modules`).
- `shared` already exists from Story 1.1 with a seed `SHARED_PACKAGE_NAME` export — keep it; add the money module alongside and re-export from `index.ts`. Do not add new dependencies (no Zod here — introduced in Story 1.3 where an AC requires it).

### Implementation guidance (prevent common mistakes)
- **`allocate` algorithm (largest-remainder):** `floor_i = total * w_i / W`; `rem_i = total * w_i mod W`; leftover `= total - Σfloor_i`; sort indices by `rem_i` desc (stable, tie-break ascending index); give `+1n` to the first `leftover` of them. All BigInt; never convert to `number`. Reject `W <= 0n` or negative weights with an explicit error.
- **Decimal parse:** split on `.`; validate `^-?\d+(\.\d+)?$`; pad/truncate-reject fractional to `scale` (reject if more digits than scale — do not silently round; rounding is `allocate`'s job, parsing must be lossless). Compose `amount = sign * (intPart * 10^scale + fracPadded)` with BigInt.
- **Never** use `Number()`, `parseFloat`, or `**` on numbers for money; use `BigInt` and `10n ** BigInt(scale)`.
- **Negatives & zero scale:** `toDecimalString` must handle `amount < 0n` (sign placement) and `scale === 0` (no decimal point).

### Testing standards
[Source: architecture.md#Structure Patterns, NFR-6]
- Vitest, co-located. Include boundary/edge cases (float rejection, odd-total split, 18-decimal token magnitudes exceeding `Number.MAX_SAFE_INTEGER` to prove BigInt correctness). This is a foundational invariant module — test thoroughly.

### References
- [Source: epics.md#Story 1.2: Provide exact-money utilities in the shared package] — user story + both AC scenarios.
- [Source: architecture.md#Data Architecture] — BigInt/NUMERIC, decimal scale, deterministic remainder preserving `V_A+V_B=K`.
- [Source: architecture.md#Format Patterns] — money as decimal strings in transit; reject float at boundary.
- [Source: architecture.md#Naming Patterns] — naming conventions.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 3 files, 35 tests passed; `pnpm format:check` → clean; `pnpm check:regime` → 0.

### Completion Notes List

- **AC-1 satisfied:** `Money` is `{ asset, scale, amount: bigint }` — integer smallest-units + decimal scale (EUR=2, BTC=8; tokens pass scale explicitly). Float rejected at every construction path (`assertNotFloat`, `money()`, `fromDecimalString`).
- **AC-2 satisfied:** `allocate` (largest-remainder/Hamilton) and `splitInTwo` guarantee parts sum to the total exactly (the `V_A + V_B = K` primitive); money (de)serializes via `toDecimalString`/`fromDecimalString` — decimal strings only, never JS `number`.
- TDD: tests written first (red), then implementation (green). Two refactor fixes during the gate: `noUncheckedIndexedAccess` destructuring default (`intPart = '0'`) and `prefer-const` on `leftover`.
- `allocate` generalizes to negative totals (residual distribution follows the sign) though current callers use non-negative pools; all arithmetic is BigInt — never converts to `number`.
- No new dependencies (Zod deferred to Story 1.3 where an AC requires it). Kept the `SHARED_PACKAGE_NAME` seed export from Story 1.1.
- Scope discipline: only money primitives; no coupled-pair leg math (`V_A=(K/2)(1+L·r)` — Epic 2/7), no persistence (Story 1.4).

### File List

- `prod/packages/shared/src/money.ts` (new)
- `prod/packages/shared/src/money.test.ts` (new)
- `prod/packages/shared/src/index.ts` (modified — re-export money API)

## Change Log

- 2026-06-15 — Story 1.2 implemented: exact-money primitives in `@rose/shared` (`Money` bigint+scale, float rejection, decimal-string (de)serialization, exact add/sub/negate, largest-remainder `allocate`/`splitInTwo` preserving totals). TDD; 35 tests. All gates green. Status → review.
- 2026-06-15 — Code review (3 adversarial layers) + remediation: added a scale guard (explicit scale must not contradict a known asset's canonical scale) and froze returned `Money` objects at runtime (`Object.freeze`). +4 tests (39 total). All gates green. Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 parallel adversarial layers)
**Date:** 2026-06-15
**Outcome:** Approve (after remediation). Both ACs independently confirmed met; NFR-2 honored; no scope creep.

### Acceptance verdict
- **AC-1 (BigInt smallest-units + per-asset scale; float rejected at boundary):** SATISFIED — verified element-by-element.
- **AC-2 (deterministic remainder preserving totals; decimal-string transport):** SATISFIED — `allocate`/`splitInTwo` sum-preservation proven (incl. negative totals, zeros, skew, >MAX_SAFE_INTEGER); decimal (de)serialization round-trips losslessly; no `number` path.

### Action Items
- [x] [Review][Patch][Med] Explicit `scale` could silently contradict a known asset's canonical scale (`money('EUR',1n,8)`), producing same-asset values that can't be combined. Fixed: `resolveScale` refuses a mismatched explicit scale for known assets (tokens unaffected). [prod/packages/shared/src/money.ts]
- [x] [Review][Patch][Med] Returned `Money` objects were not frozen at runtime (`readonly` is compile-time only) → mutable value objects. Fixed: `Object.freeze` on all constructors/arithmetic results. [prod/packages/shared/src/money.ts]
- [x] [Review][Dismiss][Low] `-0.00` canonicalizes to `0.00`, and trailing-zero / `"1."` / `".5"` / `"+1.0"` strings are rejected — all confirmed intended (lossless, no silent rounding; BigInt has no negative zero). No action.
