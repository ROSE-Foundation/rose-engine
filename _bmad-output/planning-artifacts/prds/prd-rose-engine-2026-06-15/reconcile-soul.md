# Reconciliation: PRD ↔ "Revealing the Soul of ROSE" (v1.0)

**Date:** 2026-06-15
**PRD reconciled:** `prd.md` (+ `addendum.md`) — ROSE Engine product, P0 vertical-slice MVP
**Source input:** `docs/Revealing the Soul of ROSE Version 1.0.docx` — the vision/philosophy layer of the whole ROSE movement
**Purpose:** Surface qualitative / vision / tone ideas relevant to the **Engine** that an FR-structured PRD can silently drop. Scope guard: only the Engine product is in scope; broad-movement material is explicitly marked out of scope, not a gap.

---

## Already captured (no action needed)

These Engine-relevant Soul ideas are present in the PRD and are noted only to bound the gap list:

- **"the first moment at which ROSE must not only make sense, but *work*"** — captured verbatim in §1 Vision.
- **"Engine-first → Funding-first" sequencing** — captured in §13 ("funding gateway") and Addendum H.
- **Limited / bounded risk via the coupled pair** — captured in §1 ("bounded risk"), §18 ("risk-bounded rather than speculative"), and the delta-neutral-at-issuance framing throughout.
- **Coupled long+short to access significant markets** — captured as the coupled-pair / L-Token+S-Token mechanism.

---

## Gaps (Engine-relevant, genuine)

### GAP 1 — Anti-overbuild discipline: "sufficient precision, not maximal elaboration" *(strongest gap)*
The Soul doc (§3 Engine, "How") states a clear design philosophy for the Engine that the PRD does **not** carry:

> "it should be developed with focus and discipline, without prematurely encoding unnecessary complexity into technical systems… resisting the temptation to overbuild too early. Not every future feature must be implemented in software from the beginning if simpler contractual or structural forms can already support the first phase. The discipline of the current phase is therefore not maximal elaboration, but sufficient precision."

The PRD has *scope* discipline (Non-Goals §5, small-scale MVP §6, no-venue), but not this *build-philosophy* discipline — the idea that some early needs are better met by **contractual/structural forms than by software**. This is materially relevant because the PRD deliberately **widened** P0 into a full live vertical slice (real subscription, on-chain minting, strategy execution). That widening is a legitimate decision, but it sits in direct tension with the Soul doc's explicit "don't overbuild too early" principle. The Vision (§1) and/or §13 should acknowledge this tension and state why the widened P0 is still "sufficient precision" rather than premature elaboration — otherwise the source's central Engine discipline is silently dropped.

### GAP 2 — "Elegance / structural coherence strong enough to sustain trust, scale, and long-term application"
> "its elegance matters: the underlying model must not only function technically, but reveal a structural coherence strong enough to sustain trust, scale, and long-term application."

The PRD's success framing is binary ("does it work / is the model refuted"). The Soul doc adds a **qualitative** bar above "works": the model must be *elegant / coherent enough to generate trust and survive scale*. This is exactly the kind of vision/tone idea an FR-structured PRD drops. It belongs in §1 Vision or as context around SM-2/SM-3 — the model passing the trial is necessary but not sufficient; its coherence is what earns the board's confidence to scale.

### GAP 3 — Engine as "the primary operational threshold" (make-or-break gate)
> "the Engine is also the primary operational threshold of the project. It is the point at which aspiration must become generative capacity… the first major operative threshold."

The PRD captures "must work" but not the **threshold/gate weight** — that the entire wider ROSE architecture remains "meaningful in principle but constrained in practice" until this one threshold is crossed. §13 gestures at this ("must work… before downstream domains can be funded") but the sharper "primary operational threshold — aspiration becomes generative capacity" framing strengthens the *why this matters now* and is worth lifting into Vision/§13.

### GAP 4 — Demonstration effect: proving a different financial logic can work
> "If successful, the Engine does not merely support ROSE internally. It becomes part of a larger demonstration that a different financial logic can work in practice… becoming compelling enough that its wider adoption appears increasingly self-evident." / "Its deeper role is to redirect generative financial capacity toward the emergence of a new socio-economic field" — "not meant merely to extract value from markets in the old sense."

The PRD frames surplus as feeding the Commons (§13). The Soul doc adds a distinct Engine-specific *why*: a working Engine is itself a **proof/demonstration** that a non-extractive financial logic is viable. This is a tone/vision element absent from the PRD; a sentence in §1 or §13 would preserve it without expanding scope.

### GAP 5 — Relational issuance: "money creation never unilateral, always in relation" *(borderline)*
> "Money creation… does not occur unilaterally, but always in relation. Through the coupled coin mechanism, currencies are created in paired form, so that issuance is structurally linked to corresponding demand on both sides."

The PRD treats the coupled pair purely as a **delta-neutral risk** device. The Soul doc frames coupled issuance as **relational issuance** — value created only in paired relation to demand, never unilaterally. This is *mostly* a Money-System-layer idea (local↔counterpart currencies) and so largely out of Engine scope, but the underlying "issuance is relational, not unilateral" principle does describe the Engine's coupled pair too. Worth at most a one-line context note in §13/Vision so the philosophical root of the coupled pair isn't lost; not a required Engine capability.

---

## Intentionally out of scope (NOT gaps)

The following Soul-doc material is the broad-movement vision/philosophy layer and is correctly **excluded** from an Engine product PRD. Listing it so its absence is understood as deliberate, not an oversight:

- **Karma→Dharma, Hopi "Fifth World" cosmology, the socio-sphere / civilizational-correction narrative** — movement philosophy.
- **ROSE Money System** (plural/local currencies, relational value, green-to-grey ratio, "is this money flow in service of life?", land-backed local tokens) — adjacent domain; only the coupled-coin root touches the Engine (GAP 5).
- **ROSE EDIN** (contribution/participation platform), **Living Movement** (consciousness work, deconditioning, money trauma), **Balanced Governance** (stewardship, yin/yang, value clarification) — separate domains explicitly outside the Engine per PRD §0/§5.
- **"Earth as the true shareholder," Commons spirituality, service-to-life as organizing principle** — purpose layer; the Engine PRD already references Commons as bounding context (§13) without specifying it.
- **Values list (RIGI DOC: the 4 Agreements, abundance+frugality, etc.) and brand/identity notes** — organizational culture, not Engine requirements.

---

## Recommended PRD touch-points (if actioned)

- **§1 Vision** — add the anti-overbuild / "sufficient precision not maximal elaboration" discipline (GAP 1, acknowledging the widened-P0 tension) and the "elegance / coherence enough to sustain trust and scale" bar (GAP 2).
- **§13 Capital Structure & Commons (context)** — strengthen with "primary operational threshold" framing (GAP 3) and the "demonstration that a different financial logic works" why (GAP 4); optional one-line relational-issuance note (GAP 5).
