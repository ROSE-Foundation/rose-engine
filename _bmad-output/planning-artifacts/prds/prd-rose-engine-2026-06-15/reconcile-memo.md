# Reconciliation — PRD vs. Source Memo

- **PRD reconciled:** `prd.md` (+ `addendum.md`), ROSE Engine, 2026-06-15
- **Source input:** `docs/ROSE PROJECT MEMO 20052026.pdf` — "ROSE Project – Internal Structure Memo" (legal & tokenisation structure, 4 pages incl. ROSE and Laplace structure diagrams)
- **Date:** 2026-06-15
- **Purpose:** Surface substance in the memo that materially affects the Engine product but is missing, weakened, or mislabeled in the PRD. Distinguish genuine gaps from intentional decisions.

This memo is the legal/structure source. Most of its entity and ownership content is already carried into the PRD (§12, §13) and `addendum.md` §F–G. The gaps below are the residue that is product-relevant and not yet captured.

---

## Gaps

### GAP 1 — VCC-level account stack + the "cash/NAV-only vs. token/trading" routing rule (STRONG)

- **Memo location:** §2 (p1): "Investor subscriptions and redemptions occur at the VCC level in either fiat or crypto, flowing through dedicated **bank and brokerage accounts and a wallet / custodian stack** shown directly under the VCC. **These accounts are used for cash and NAV movements only; token and trading flows are routed through the operating entities.**" Confirmed in the ROSE diagram (p3): under ROSE VCC sit a "Bank Account & Brokerage" box and a "Wallet / Custodian" box.
- **Why it matters:** This is a structural segregation principle, not just a chart label. It dictates *which entity's book a movement may post against*: the VCC carries cash/NAV (incl. fiat and crypto subscription proceeds) but is NOT a venue for token/trading flows — those route through Trading Co. and Coin Issuer Co. The PRD's four-entity / five-account-type model (§3, FR-1) has no representation of (a) a VCC wallet/custodian, or (b) the rule that VCC accounts are cash/NAV-only. This directly bears on the `flow_permissions` rule set (FR-8), the chokepoint authorization (FR-7), and ledger↔chain reconciliation (FR-10) — e.g. a token/trading posting landing on a VCC account should arguably be default-denied.
- **Suggested PRD home:** §4.1 (account model / FR-1 consequences) and §4.3/FR-8 (add a permission rule: token/trading flows do not post to VCC cash-NAV accounts). Mention the VCC wallet/custodian in §12.

### GAP 2 — Entity code `ISSUER_EXCHANGE` conflates issuer with exchange; the memo separates them (STRONG, terminology/structural)

- **Memo location:** §4 (p1) + §5 (p2) + diagram (p3). The memo's fourth operating entity is **"Rose Coin Issuer Co. (Offshore – Jurisdiction 2)"** whose role is *token issuance/lifecycle, coin treasury, and on-chain liquidity (wallets, DEX pools)*. The **exchange accounts (CEX / DEX / on-chain)** belong to **Rose Offshore Trading Co. (Jurisdiction 1)** — "deploy capital, manage margin, execute strategies."
- **Why it matters:** The PRD's fixed entity code is `ISSUER_EXCHANGE` (§3 Glossary, FR-1), and FR-14 names an "Exchange / Trading view." Naming the *issuer* entity `…_EXCHANGE` mislabels the structure: in the memo the issuer does NOT run an exchange; exchange/execution venue accounts sit under Trading Co. This risks postings (and the Exchange/Trading surface) being attached to the wrong book and muddies the issuer-vs-trading separation that the whole legal structure rests on.
- **Suggested PRD home:** §3 Glossary "Entity" + FR-1: rename the fourth entity to `COIN_ISSUER` (or `ISSUER`) per the memo; locate CEX/DEX/on-chain exchange accounts under `TRADING_CO`; clarify the FR-14 "Exchange/Trading view" maps to Trading Co. activity, not the issuer.

### GAP 3 — Coupled packages flow *between entities* as collateral / hedging / liquidity inventory, always as whole packages (MEDIUM)

- **Memo location:** §5 (p2): "The same coupled packages can be placed under the management of the **Trading Co. for use in hedging, collateralisation, and market-making.** Even when a package is operationally deployed within Trading Co., it is viewed from the VCC's perspective as an **intact L+S unit**; flows … between VCC, Coin Issuer, Trading Co., and external venues … refer to movement of **whole packages, not free-standing long or short legs.**"
- **Why it matters:** The PRD's "never a single leg" rule (Glossary, FR-6) is framed around *issuance and persistence*. The memo adds a second, product-relevant dimension: coupled packages *move between entities* (Coin Issuer → Trading Co → external venues) as collateral/hedging/liquidity-inventory, and every such inter-entity token flow is a whole package. This is the substance behind the red-dashed token-flow arrows and affects how the hybrid ledger (FR-18, NFR-9) tracks token quantities across entity books and reconciles them to chain (FR-10) — inter-entity package transfers must keep both legs together across entity boundaries, not just within one issuance.
- **Suggested PRD home:** §4.2/FR-6 (extend "never a single leg" to inter-entity package movement) and §4.5/§14 (token packages as collateral/hedging/liquidity moving Issuer↔Trading Co.). Likely P0-boundary-flagged, but the convention should be stated.

### GAP 4 — Coin Issuer's on-chain liquidity provision / coin treasury / market-making is a named responsibility with no PRD home (MEDIUM-LOW)

- **Memo location:** §5 (p2) + diagram (p3): Rose Coin Issuer Co. "manages the **coin treasury**, and provides **on-chain liquidity** via dedicated wallets and **DEX liquidity pools**"; Trading Co. does "market-making." (`addendum.md` §F captures the words "coin treasury, on-chain liquidity (wallets, DEX pools)" but no PRD requirement or scope line references them.)
- **Why it matters:** On-chain liquidity provisioning (DEX pools) and a coin treasury are real Issuer responsibilities that hold value and move tokens. The PRD mints tokens (FR-18) but is silent on treasury/liquidity-pool accounts and the activity. This is plausibly an intentional P0 boundary (PRD §5 excludes a "general trading venue"), but on-chain *liquidity provision* is distinct from a matching engine and is not explicitly scoped out.
- **Suggested PRD home:** §6.2 Out-of-Scope (explicitly defer Issuer DEX-liquidity/market-making and coin treasury to post-P0), or §4.5 if any of it is in P0.

---

## Intentional divergences (NOT gaps — confirmed already handled)

- **"Upgrade the current platform stack."** Memo p3 (Laplace para) frames ROSE as an upgrade of the Laplace stack. Overridden by decision: ROSE Engine is **greenfield**; Laplace is precedent only (PRD §0 build-approach note, §5, addendum §G). Intentional — not a gap.
- **Flow conventions (solid = legal ownership; green = cash/NAV/fees; red dashed = token/crypto operational flows that do NOT change legal ownership).** Memo §6 (p2) + diagram legend. Captured in `addendum.md` §F ("solid = legal ownership; green = cash/NAV; red dashed = token/crypto operational flows (do not change legal ownership)"). Covered, though terse — the semantic that token flows are operational and never alter equity ownership underpins GAP 1/GAP 3 above.
- **Ownership/governance chain (VCC 100% owns Rose Holding → Trading Co. + Coin Issuer Co.; P&L accrues to VCC via equity).** Memo §3–§4. Carried in PRD §13 and addendum §F. Covered.
- **Namara as licensed IM; VCC = Note Issuer; Singapore VCC sub-fund "Rose Perpetual Strategies"; two offshore jurisdictions TBD; ARP + perpetual-futures strategies; Laplace AM sole subscriber via laplace.digital.** All present in PRD §12/§16 and addendum §F–G. Covered.
- **The five PRD account *types* (BACKING_FLOAT, DEPLOYED_CAPITAL, CLIENT_COLLATERAL, FEE_INCOME, NOTE_LIABILITY) vs. the memo's operational account *boxes* (bank/brokerage, wallet/custodian, exchange accounts, coin wallets/treasury, DEX pools).** The PRD deliberately models economic books rather than operational accounts — an intentional abstraction. Noted only because GAP 1/GAP 2 are about which *entity* a flow attaches to, not the type taxonomy.
