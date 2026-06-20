import { cn } from '../../lib/cn.js';

/** The surfaces the Home cards route to (subset of the app's Surface union). */
export type HomeSurface = 'exchange-trading' | 'covenant-console' | 'coupled-pair';

interface HomeCard {
  readonly surface: HomeSurface;
  readonly num: string;
  readonly icon: string;
  readonly title: string;
  readonly role: string;
  readonly blurb: string;
  readonly features: readonly string[];
  readonly cta: string;
  readonly edge: string; // text-* accent (literal so Tailwind generates it)
  readonly iconBg: string; // tinted icon background (literal)
  readonly dot: string; // bg-* for feature bullets (literal)
}

const CARDS: readonly HomeCard[] = [
  {
    surface: 'exchange-trading',
    num: '01',
    icon: '⇄',
    title: 'Exchange',
    role: "Trader's view",
    blurb:
      'The trading terminal where coupled coins are offered across five markets — FX, crypto, commodity, equity, and rates.',
    features: ['Five coupled-coin markets', 'Long / short token pairs', 'Segregated collateral'],
    cta: 'Enter exchange',
    edge: 'text-blue',
    iconBg: 'bg-blue/10',
    dot: 'bg-blue',
  },
  {
    surface: 'covenant-console',
    num: '02',
    icon: '◈',
    title: 'Treasury Dashboard',
    role: "Liquidity manager's view",
    blurb:
      'The clearing-house control room. Live covenant monitoring, consolidated NAV, and proof that every bright line holds.',
    features: [
      'Covenant / bright-line monitor',
      'Cross-entity reconciliation',
      'Three-stream treasury yield',
    ],
    cta: 'Open dashboard',
    edge: 'text-gold',
    iconBg: 'bg-gold/10',
    dot: 'bg-gold',
  },
  {
    surface: 'coupled-pair',
    num: '03',
    icon: '⊕',
    title: 'Coupled Coins',
    role: 'The mechanism',
    blurb:
      'An animated walkthrough from Rose Note funding to issuance, mark-to-market, and the invariant: collateral never changes.',
    features: ['Six-scene flow, auto-play', 'Live mark-to-market', 'Threshold rebalance demo'],
    cta: 'Play walkthrough',
    edge: 'text-long',
    iconBg: 'bg-long/10',
    dot: 'bg-long',
  },
];

const FOOTER_LINES = [
  'Cash-backed',
  'Threshold-only rebalancing',
  'Client collateral segregated',
  'Delta-neutral by construction',
];

/**
 * A living, English overview of what this POC/DEMO does. KEEP THIS CURRENT: whenever a user-facing
 * capability of the paper/demo app changes (a new tab, a new flow, a changed behaviour), update this
 * block in the same change so the first page never drifts from what the app actually demonstrates.
 */
const DEMO_OVERVIEW = {
  badge: 'Paper or production-faithful mode · no real capital · contracts untouched',
  lead:
    'ROSE Engine is an interactive proof-of-concept for a cash-backed coupled-coin system and its ' +
    'off-chain secondary-trading position layer. It runs in one of two simulated modes — paper (every ' +
    'subscribe, redeem, open, close and reset auto-confirms in-process) or production-faithful (the ' +
    'same flows over an asynchronous on-chain confirmation, a real default-deny authorization gate, ' +
    'and a mocked counterparty) — so the full mechanism can be exercised safely, end to end, without a ' +
    'testnet or real money. The always-visible banner at the top states exactly what is real vs ' +
    'mocked in the running mode; no real capital ever moves and the deployed contracts are untouched.',
  capabilities: [
    {
      label: 'The coupled-coin instrument',
      text:
        'At issuance a single cash collateral pool backs a delta-neutral long/short token pair. The ' +
        'collateral pool never changes, each leg is floored at zero (never liquidated into debt), and ' +
        'rebalancing is threshold-only.',
    },
    {
      label: 'Trade directional positions',
      text:
        'From the Exchange terminal you open and close positions over the real atomic ' +
        'subscribe→mint / redeem→burn package flow, with live moving marks and unrealized P&L. ' +
        'Leverage is pinned to 1× in this P0 (the selector is shown disabled).',
    },
    {
      label: 'Solvency guardrail (§11.4)',
      text:
        'An independent single-side close — when the opposite leg is held by another user — is ' +
        'fail-closed with an explicit, rule-named refusal. The on-chain package is burned only when ' +
        'both sides are released.',
    },
    {
      label: 'Position ↔ pair reconciliation',
      text:
        'A per-(pair, side) residual-backing report proves off-chain exposure never exceeds the real ' +
        'collateral. Over-exposure on one side is reported, never masked by headroom on another.',
    },
    {
      label: 'Live price simulation',
      text:
        'The Simulation tab tunes the replay price feed and selects its mode — a clock-based sine, or a ' +
        'directional-change (intrinsic-time) δ-threshold walk that reverses on price moves, not the clock. ' +
        'Push the amplitude past the trust band to see a mark flagged DIVERGENT — marks are never ' +
        'fabricated; an absent or stale feed shows an explicit state, not a number.',
    },
    {
      label: 'Treasury & mechanism views',
      text:
        'The Treasury Dashboard monitors covenants and consolidated NAV; the Coupled Coins ' +
        'walkthrough animates issuance, mark-to-market and the collateral invariant end to end.',
    },
    {
      label: 'Production-faithful mode',
      text:
        'In ENGINE_MODE=faithful the same flows run closer to production: the on-chain confirmation ' +
        'is asynchronous (a configurable latency that can be made to fail → real saga compensation, ' +
        'no half-applied state), capital movement is gated by a REAL default-deny authorization fronted ' +
        'by a mocked KYC/AML onboarding, each participant signs in to their own multi-user session, a ' +
        'mocked counterparty unlocks the independent single-side close via house re-assignment, and an ' +
        'operator panel injects production-like events (latency/failure, covenant breach, reconcile ' +
        'divergence). What is real (ledger, contracts, default-deny gate, reconciliation) vs mocked ' +
        '(confirmation latency, KYC issuer, counterparty, price feed) is stated honestly in the banner.',
    },
    {
      label: 'Delta Engine (research)',
      text:
        'A throwaway research tab implementing the Glattfelder/Houweling/Olsen (2025) paradigm: a ' +
        'contrarian, multi-scale directional-change (intrinsic-time) trading model. One agent per δ ' +
        'threshold fits support/resistance to overshoot events and fades breakouts, a volatility ' +
        'scaling law silences out-of-sync agents, and the net exposure oscillates between +u and −u, ' +
        'decoupled from PnL (no take-profit / stop-loss). Disjoint from the ROSE P0 mechanism.',
    },
  ],
} as const;

/** The landing screen (mock `index.html`): an intro + three view cards + a status footer. */
export function Home({
  onSelect,
}: {
  onSelect: (surface: HomeSurface) => void;
}): React.JSX.Element {
  return (
    <div className="mx-auto flex min-h-full max-w-[1120px] flex-col">
      <div className="max-w-[680px]">
        <p className="font-numeric text-xs uppercase tracking-[0.25em] text-blue">Select a view</p>
        <h2 className="mt-3.5 font-display text-4xl font-medium leading-tight tracking-tight">
          One instrument, seen from <em className="text-gold">three sides</em>.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Coupled coins manufacture liquidity at issuance — a delta-neutral long/short pair backed
          by a single cash collateral pool. Explore the system from the trader&apos;s terminal, the
          treasury&apos;s control room, or the mechanism itself.
        </p>
      </div>

      <div className="mt-10 grid flex-1 content-center gap-4 md:grid-cols-3">
        {CARDS.map((c) => (
          <button
            key={c.surface}
            type="button"
            onClick={() => onSelect(c.surface)}
            className="group relative flex flex-col rounded-[18px] border border-border bg-card p-6 text-left transition-[transform,border-color] hover:-translate-y-1.5 hover:border-border-strong motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <span className="absolute right-6 top-6 font-numeric text-sm text-dim">{c.num}</span>
            <span
              className={cn(
                'mb-5 flex h-[54px] w-[54px] items-center justify-center rounded-[14px] text-2xl',
                c.iconBg,
                c.edge,
              )}
              aria-hidden
            >
              {c.icon}
            </span>
            <h3 className="text-lg font-semibold">{c.title}</h3>
            <p className={cn('mb-3.5 font-numeric text-[11px] uppercase tracking-wide', c.edge)}>
              {c.role}
            </p>
            <p className="flex-1 text-sm leading-relaxed text-muted-foreground">{c.blurb}</p>
            <ul className="my-4 flex flex-col gap-1.5">
              {c.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-xs text-dim">
                  <span className={cn('h-1 w-1 rounded-full', c.dot)} aria-hidden />
                  {f}
                </li>
              ))}
            </ul>
            <span className={cn('mt-auto flex items-center gap-2 text-sm font-semibold', c.edge)}>
              {c.cta}{' '}
              <span className="transition-transform group-hover:translate-x-1" aria-hidden>
                →
              </span>
            </span>
          </button>
        ))}
      </div>

      <section
        aria-labelledby="demo-overview-heading"
        className="mt-12 rounded-[18px] border border-border bg-card p-6 md:p-8"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3
            id="demo-overview-heading"
            className="font-display text-2xl font-medium tracking-tight"
          >
            What this proof-of-concept does
          </h3>
          <span className="font-numeric text-[11px] uppercase tracking-wide text-blue">
            {DEMO_OVERVIEW.badge}
          </span>
        </div>
        <p className="mt-4 max-w-[820px] text-sm leading-relaxed text-muted-foreground">
          {DEMO_OVERVIEW.lead}
        </p>
        <dl className="mt-6 grid gap-x-8 gap-y-5 md:grid-cols-2">
          {DEMO_OVERVIEW.capabilities.map((cap) => (
            <div key={cap.label}>
              <dt className="text-sm font-semibold">{cap.label}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{cap.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-9 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <div className="flex flex-wrap gap-4">
          {FOOTER_LINES.map((l) => (
            <span key={l} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="h-1.5 w-1.5 rounded-full bg-long shadow-[0_0_6px_var(--long)]"
                aria-hidden
              />
              {l}
            </span>
          ))}
        </div>
        <span className="font-numeric text-[11px] text-dim">ROSE Engine</span>
      </div>
    </div>
  );
}
