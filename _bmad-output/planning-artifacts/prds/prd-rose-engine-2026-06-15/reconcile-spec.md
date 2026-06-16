# Reconciliation: PRD ↔ SPEC.md

**Source input:** `docs/SPEC.md` (Rose Engine — Spécification de développement v0.1, the original P0 engineering spec, French).
**PRD under review:** `prd.md` + `addendum.md` (prd-rose-engine-2026-06-15).
**Date:** 2026-06-15.

**Method.** Read SPEC.md in full against the PRD and addendum. The PRD deliberately supersedes SPEC on several P0 non-objectives (off-chain-only, no EVM, no smart contracts, no live trading, no minting, on-chain auth at P3+ — all now in P0). Those divergences are intentional and are confirmed at the bottom, not flagged as gaps. What follows are places where genuine substance in SPEC was dropped or softened by the PRD and arguably should be preserved.

Overall: the load-bearing SPEC substance is well preserved — the coupled-coin math and `f = m·L·g` formula (addendum D), the issuer-neutral invariant `V_A+V_B=K`, threshold-only rebalancing + the leveraged-ETF volatility-decay rationale (FR-16, §4.7, addendum D), the DB-enforced double-entry invariant (FR-3, addendum B), the single `postTransfer` chokepoint + default-deny (FR-7/8), the parked-parameter refuse-don't-default rule (§11.2, NFR-4, FR-8, addendum I), the two-regime discipline and `/prod`-never-imports-`/throwaway` rule (§11.1, addendum E), and the "over-specify and freeze the coupled-pair contract first" discipline (FR-6). The gaps below are narrower.

---

## Genuine gaps

### Gap 1 — "No accidental path to real money" safety framing (softened, and now more salient)
- **SPEC says:** §10 (Rappels de séquençage): in P0/throwaway nothing touches real money, "**mais le code ne doit pas créer de chemin par lequel cela deviendrait possible par accident**" — the code must not create a path by which touching real money becomes possible by accident.
- **Where:** SPEC.md §10 (lines 153–154).
- **PRD status:** Softened. §11.3 says "the off-chain ledger + on-chain compliance must both be in force before any move to real capital/mainnet." It states the precondition but drops the explicit *anti-accident* guard on the boundary itself.
- **Why it matters:** Under SPEC, P0 was entirely off-chain/in-memory, so an accidental real-money path was almost unreachable. Under the PRD, P0 now has **live code paths** for subscription, minting, and execution — running on Sepolia testnet + paper only by configuration. The testnet/paper-vs-mainnet/real boundary is now a runtime/config switch rather than an absent feature, which makes SPEC's "no accidental crossing" requirement *more* important than before, not less. The PRD should require that crossing from testnet/paper to mainnet/real-capital cannot happen by accident (e.g. an explicit, board-gated config gate, not a code path that silently activates).
- **Suggested PRD home:** §11.3 Sequencing guardrail (add an explicit "no accidental testnet/paper → mainnet/real crossing" clause), reinforced by a line in NFR-4 (fail-closed) or a short NFR.

### Gap 2 — `jurisdiction` attribute on entities
- **SPEC says:** §3.1 `entities` table carries a `jurisdiction` column alongside `code` and `created_at`.
- **Where:** SPEC.md §3.1 (line 43).
- **PRD status:** Dropped. FR-1 models entities with code/type/asset/decimal-scale but no jurisdiction attribute; the Glossary "Entity" entry lists the four codes only.
- **Why it matters:** §12 establishes that Trading Co. and Coin Issuer Co. sit in two distinct (TBD) offshore jurisdictions, with the VCC in Singapore — jurisdiction separation is a core regulatory constraint. Carrying jurisdiction on the entity record is the data hook that lets the group view / reconciliation reflect that separation and is the natural place the TBD jurisdictions land once chosen.
- **Suggested PRD home:** FR-1 consequences (add jurisdiction to the per-entity attributes), and/or the addendum schema notes.

### Gap 3 — `journal_entries.description` (human-readable narration)
- **SPEC says:** §3.2 `journal_entries` has a `description` field.
- **Where:** SPEC.md §3.2 (line 48).
- **PRD status:** Dropped. FR-2 preserves the nullable `coupled_pair_id` link but not a description/narration field.
- **Why it matters:** NFR-3 (Auditability) makes every movement attributable to a journal entry; a human-readable description is what makes that audit trail legible to a steward/board at sign-off (UJ-2). Small but cheap to lose and useful to keep.
- **Suggested PRD home:** FR-2 consequences, or the addendum data-model notes.

### Gap 4 — Concrete field types / precision for the coupled-pair contract
- **SPEC says:** §3.4 over-specifies the `coupled_pairs` schema with concrete types: `anchor_price decimal(18,8)`, `leverage decimal`, `floor decimal`, `reference_asset text`, plus `created_at`/`updated_at timestamptz`. (SPEC `collateral_pool K bigint` is intentionally superseded — see below.)
- **Where:** SPEC.md §3.4 table (lines 58–68).
- **PRD status:** Partially dropped. FR-6 lists the *fields* of the contract but not their types/precision; addendum A revisits monetary `NUMERIC`/`BigInt` but does not carry the `anchor_price decimal(18,8)` price precision or the other column types.
- **Why it matters:** SPEC explicitly calls this "the most important artifact" and says to over-specify and freeze it before dependent work. Price precision (`decimal(18,8)`) for the anchor is a concrete decision that affects re-anchoring math and reconciliation; losing it forces a re-decision downstream. This is "how" detail, so it belongs in the addendum, not the PRD body — but it should be captured somewhere rather than dropped.
- **Suggested PRD home:** addendum A or a dedicated addendum data-model section.

---

## Confirmed intentional supersessions (checked — NOT gaps)

These SPEC statements are deliberately overridden by the PRD (per §0 purpose note, §5 note, and addendum A/C). Flagged so the parent knows they were reviewed, not missed:

- **SPEC §0 / §3.5:** "No EVM, no smart contracts, no on-chain deployment; on-chain authorization is a P3+ target; app-level enforcement as accepted v1 debt." → Superseded: ERC-3643 on Sepolia + on-chain compliance modules are in P0 (FR-18, FR-19, §4.3, addendum C).
- **SPEC §0 / §8:** "No functional exchange/matching/onboarding → static mockups only, each headed `MOCKUP — NON FONCTIONNEL`." → Superseded: all four surfaces are functional/live-data in P0 (FR-14, §4.6); no mockups.
- **SPEC §0 / §8:** "No real client money, no user auth, no KYC." → Superseded in part: live subscription/redemption + ERC-3643 identity/eligibility infra are in P0 (on testnet/paper, no real capital); self-service KYC remains out (allowlist instead, §5).
- **SPEC §0 / §3.4 / §6–7:** "No multi-asset; sole reference asset = EUR/USD at L=1." → Superseded: BTC at L=1 added as a deliberate stress test, and **L is a per-pair parameter, never hard-coded** (FR-6, §4.7, SM-C1).
- **SPEC §3.4 / §3.5:** `collateral_pool K bigint`; `amount` bigint. → Superseded: integers in smallest units with `BigInt` in code and `NUMERIC` where int64 is insufficient (18-decimal tokens) — NFR-2, addendum A.
- **SPEC §2:** "Choose TypeScript *or* Python and stick with it." → Superseded: TypeScript default + Rust/Go for performance hot paths (NFR-7, addendum A).
- **SPEC §4:** Reconciliation = per-entity vs consolidated only. → Extended (not lost): PRD adds ledger ↔ chain quantity reconciliation (FR-10, NFR-9).
