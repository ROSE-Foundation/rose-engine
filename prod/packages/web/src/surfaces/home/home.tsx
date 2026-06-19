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
