import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../../lib/cn.js';
import { deriveFloorUnits, legsAtPrice } from '../../../lib/pair-math.js';
import { useReducedMotion } from '../../../lib/use-reduced-motion.js';

/** Simulation parameters for the interactive scenes — sourced from a live pair when available,
 *  otherwise an explicitly-illustrative example (never presented as live data). */
export interface WalkthroughParams {
  referenceAsset: string;
  anchorPrice: string;
  leverage: string;
  collateralPool: string;
  floor: string;
  illustrative: boolean;
}

const ILLUSTRATIVE: WalkthroughParams = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.0850',
  leverage: '1',
  collateralPool: '1000000',
  floor: '0.10',
  illustrative: true,
};

const SCENE_TITLES = [
  'Investors fund the Rose Note',
  'The pool mints a matched pair',
  'The pair is listed on the exchange',
  'Price moves — the collateral does not',
  'The holders take the risk; the pool stays whole',
  'At higher leverage, a threshold reset protects the loser',
];
const DWELL_MS = [6000, 6000, 6000, 11000, 7500, 13000];
const SCENE_COUNT = SCENE_TITLES.length;

function fmtUnits(v: bigint): string {
  return `${v.toLocaleString('en-US')} units`;
}
function legPct(leg: bigint, k: bigint): number {
  if (k <= 0n) return 0;
  return Number((leg * 10000n) / k) / 100;
}
function pctLabel(leg: bigint, half: bigint): string {
  if (half <= 0n) return '+0%';
  const bps = Number(((leg - half) * 10000n) / half) / 100;
  return `${bps >= 0 ? '+' : ''}${bps.toFixed(1)}%`;
}

/** A flow-diagram node (structural scenes — explanatory, not live data). */
function FlowNode({
  icon,
  title,
  lines,
  amount,
  accent,
  lit = true,
}: {
  icon: string;
  title: string;
  lines: React.ReactNode;
  amount?: string;
  accent: string;
  lit?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex-1 rounded-lg border border-border bg-card p-5 text-center transition-opacity',
        lit ? 'opacity-100' : 'opacity-40',
      )}
    >
      <span
        className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-lg"
        aria-hidden
      >
        {icon}
      </span>
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="mt-1 text-xs text-muted-foreground">{lines}</div>
      {amount !== undefined && (
        <div className={cn('mt-2 font-numeric text-sm font-medium', accent)}>{amount}</div>
      )}
    </div>
  );
}

function Conn({ active }: { active?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'mx-1 hidden h-0.5 w-10 self-center md:block',
        active ? 'bg-gold' : 'bg-border',
      )}
    />
  );
}

/** One mark-to-market bar (a leg or the collateral). */
function Bar({
  label,
  dot,
  value,
  pct,
  delta,
  fill,
  floorPct,
}: {
  label: string;
  dot: string;
  value: string;
  pct: number;
  delta?: { text: string; tone: string };
  fill: string;
  floorPct?: number;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center">
      <div className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
        <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden />
        {label}
      </div>
      <div className="mb-2.5 font-numeric text-lg font-medium tabular-nums">{value}</div>
      <div className="relative flex h-44 w-full max-w-[120px] items-end overflow-hidden rounded-lg border border-border bg-card">
        {floorPct !== undefined && (
          <span
            className="absolute inset-x-0 z-10 border-t-2 border-dashed border-gold"
            style={{ bottom: `${floorPct}%` }}
            aria-hidden
          />
        )}
        <div
          className={cn('w-full transition-[height] duration-150 motion-reduce:transition-none', fill)}
          style={{ height: `${pct}%` }}
        />
      </div>
      <div className={cn('mt-2 h-4 font-numeric text-xs', delta?.tone ?? 'text-dim')}>
        {delta?.text ?? ''}
      </div>
    </div>
  );
}

/** Scene 4 — interactive mark-to-market: a price slider revalues both legs while K stays whole. */
function MarkToMarket({ params }: { params: WalkthroughParams }): React.JSX.Element {
  const [bps, setBps] = useState(0);
  const k = BigInt(params.collateralPool);
  const half = k / 2n;
  const { longLeg, shortLeg } = legsAtPrice(
    params.collateralPool,
    params.leverage,
    params.floor,
    bps,
  );
  const sum = longLeg + shortLeg;
  const price = (Number(params.anchorPrice) * (1 + bps / 10000)).toFixed(4);
  const movePct = `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`;

  return (
    <div className="w-full max-w-[920px]">
      <div className="flex items-end gap-8">
        <Bar
          label="Token A · long"
          dot="bg-long"
          value={fmtUnits(longLeg)}
          pct={legPct(longLeg, k)}
          fill="bg-long"
          delta={{ text: pctLabel(longLeg, half), tone: longLeg >= half ? 'text-long' : 'text-short' }}
        />
        <Bar
          label="Collateral · K"
          dot="bg-gold"
          value={fmtUnits(k)}
          pct={100}
          fill="bg-gold"
          delta={{ text: 'unchanged', tone: 'text-gold' }}
        />
        <Bar
          label="Token B · short"
          dot="bg-short"
          value={fmtUnits(shortLeg)}
          pct={legPct(shortLeg, k)}
          fill="bg-short"
          delta={{ text: pctLabel(shortLeg, half), tone: shortLeg >= half ? 'text-long' : 'text-short' }}
        />
      </div>
      <div className="mt-4 rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-numeric text-sm">
            {params.referenceAsset} <b className="font-medium">{price}</b>{' '}
            <span className={cn('ml-2 text-xs', bps > 0 ? 'text-long' : bps < 0 ? 'text-short' : 'text-dim')}>
              {movePct}
            </span>
          </span>
          <span className="flex items-center gap-2 font-numeric text-sm text-muted-foreground">
            V<sub>A</sub> + V<sub>B</sub> ={' '}
            <span className={sum === k ? 'text-gold' : 'text-loss'}>{fmtUnits(sum)}</span> = K{' '}
            <span className="text-gold" aria-label={sum === k ? 'invariant holds' : 'invariant broken'}>
              {sum === k ? '✓' : '✗'}
            </span>
          </span>
        </div>
        <input
          type="range"
          min={-1500}
          max={1500}
          step={10}
          value={bps}
          onChange={(e) => setBps(Number(e.target.value))}
          aria-label={`Price move off anchor, ${params.referenceAsset}`}
          aria-valuetext={`${movePct}, long ${fmtUnits(longLeg)}, short ${fmtUnits(shortLeg)}`}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-border"
        />
        <div className="mt-1.5 flex justify-between font-numeric text-[10px] text-dim">
          <span>−15%</span>
          <span>P₀ = {params.anchorPrice}</span>
          <span>+15%</span>
        </div>
      </div>
    </div>
  );
}

interface RbStep {
  banner: string;
  tone: string;
  floor: boolean;
  legs: { longLeg: bigint; shortLeg: bigint };
}

/** Scene 6 — threshold rebalancing demo. Uses the live pair's REAL leverage + floor (so real K is
 *  never bound to invented parameters); for the illustrative example, a representative L=2 / 10%
 *  floor makes the leverage point legible. The price-shock magnitude is an explicit illustrative
 *  stress (the move that drives the short leg to the floor at this leverage). */
function Rebalancing({ params }: { params: WalkthroughParams }): React.JSX.Element {
  const [step, setStep] = useState(0);
  const k = BigInt(params.collateralPool);
  const half = k / 2n;
  // Real params for a live pair; a representative leverage/floor for the illustrative example.
  const demoLev = params.illustrative ? '2' : params.leverage;
  const demoFloor = params.illustrative ? '0.10' : params.floor;
  const floorUnits = deriveFloorUnits(params.collateralPool, demoFloor);
  const lev = Number(demoLev);
  const floorRatio = Number(demoFloor);
  const floorPct = (floorRatio * 100).toFixed(floorRatio * 100 % 1 === 0 ? 0 : 1);
  // The price move (bps) at which the short leg reaches its floor: short = K/2·(1−L·r) = floorUnits
  // ⇒ r = (1 − floorRatio) / L. Illustrative stress magnitude; real legs computed via legsAtPrice.
  const stressBps = lev > 0 ? Math.round(((1 - floorRatio) / lev) * 10000) : 4500;
  const stressPct = (stressBps / 100).toFixed(stressBps % 100 === 0 ? 0 : 1);
  const steps = useMemo<readonly [RbStep, RbStep, RbStep, RbStep]>(() => {
    const issuance = legsAtPrice(params.collateralPool, demoLev, demoFloor, 0);
    const stressed = legsAtPrice(params.collateralPool, demoLev, demoFloor, stressBps);
    return [
      { banner: `L = ${demoLev} · floor at ${floorPct}% · illustrative stress walkthrough`, tone: 'border-border bg-card text-muted-foreground', floor: false, legs: issuance },
      { banner: `Price +${stressPct}% · short leg at the floor — approaching the barrier`, tone: 'border-short bg-short/10 text-short', floor: true, legs: stressed },
      { banner: '⚡ Reset fires · dollar values locked · P₀ re-anchored to current price', tone: 'border-gold bg-gold/10 text-gold', floor: true, legs: stressed },
      { banner: 'After reset · new P₀, both legs regain room · short-leg loss locked', tone: 'border-gold bg-gold/10 text-gold', floor: false, legs: stressed },
    ];
  }, [params.collateralPool, demoLev, demoFloor, floorPct, stressBps, stressPct]);
  const clamped = (step < 0 ? 0 : step > 3 ? 3 : step) as 0 | 1 | 2 | 3;
  const cur = steps[clamped];

  return (
    <div className="w-full max-w-[900px]">
      <div className={cn('rounded-lg border px-4 py-3 text-center font-numeric text-sm', cur.tone)}>
        {cur.banner}
      </div>
      <div className="mt-4 flex items-end gap-8">
        <Bar label="Token A · long" dot="bg-long" value={fmtUnits(cur.legs.longLeg)} pct={legPct(cur.legs.longLeg, k)} fill="bg-long" delta={{ text: pctLabel(cur.legs.longLeg, half), tone: 'text-long' }} />
        <Bar label="Collateral · K" dot="bg-gold" value={fmtUnits(k)} pct={100} fill="bg-gold" delta={{ text: 'unchanged', tone: 'text-gold' }} />
        <Bar label="Token B · short" dot="bg-short" value={fmtUnits(cur.legs.shortLeg)} pct={legPct(cur.legs.shortLeg, k)} fill="bg-short" delta={{ text: pctLabel(cur.legs.shortLeg, half), tone: 'text-short' }} floorPct={cur.floor ? legPct(floorUnits, k) : undefined} />
      </div>
      <div className="mt-4 flex justify-center gap-2" role="group" aria-label="Rebalancing steps">
        {['① At issuance', `② Price +${stressPct}%`, '③ Reset fires', '④ After reset'].map((label, idx) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(idx)}
            aria-pressed={step === idx}
            className={cn(
              'rounded-md border px-3.5 py-1.5 text-xs transition-colors',
              step === idx
                ? 'border-gold bg-gold/10 text-gold'
                : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Renders the body for a given scene index. */
function SceneBody({ index, params }: { index: number; params: WalkthroughParams }): React.JSX.Element {
  const k = BigInt(params.collateralPool);
  const half = fmtUnits(k / 2n);
  const kUnits = fmtUnits(k);
  switch (index) {
    case 0:
      return (
        <div className="flex w-full max-w-[960px] flex-col items-stretch gap-3 md:flex-row md:items-center">
          <FlowNode icon="◉" title="Note holders" lines="Subscribe in fiat or crypto" amount={kUnits} accent="text-blue" />
          <Conn active />
          <FlowNode icon="▤" title="Collateral pool" lines="Cash held by the treasury" amount={`K = ${kUnits}`} accent="text-gold" />
          <Conn />
          <FlowNode icon="⊕" title="Coupled pair" lines="Not yet minted" amount="—" accent="text-dim" lit={false} />
        </div>
      );
    case 1:
      return (
        <div className="flex w-full max-w-[960px] flex-col items-stretch gap-3 md:flex-row md:items-center">
          <FlowNode icon="◉" title="Note holders" lines="Funded" amount={kUnits} accent="text-dim" lit={false} />
          <Conn />
          <FlowNode icon="▤" title="Collateral pool" lines="Backs both legs" amount={`K = ${kUnits}`} accent="text-gold" />
          <Conn active />
          <FlowNode icon="⊕" title="L + S pair" lines={<><span className="text-long">Token A {half}</span><br /><span className="text-short">Token B {half}</span></>} amount={`P₀ = ${params.anchorPrice}`} accent="text-long" />
        </div>
      );
    case 2:
      return (
        <div className="flex w-full max-w-[960px] flex-col items-stretch gap-3 md:flex-row md:items-center">
          <FlowNode icon="▤" title="Collateral pool" lines="Stays with treasury" amount={`K = ${kUnits}`} accent="text-gold" />
          <Conn active />
          <FlowNode icon="⊕" title="L + S pair" lines={<><span className="text-long">Token A tradeable</span><br /><span className="text-short">Token B tradeable</span></>} amount="listed" accent="text-long" />
          <Conn active />
          <FlowNode icon="⇄" title="Exchange" lines="Bulls buy A · bears buy B" amount="open market" accent="text-blue" />
        </div>
      );
    case 3:
      return <MarkToMarket params={params} />;
    case 4:
      return (
        <div className="w-full max-w-[820px]">
          <div className="mb-4 flex flex-col gap-4 md:flex-row">
            <div className="flex-1 rounded-lg border border-border bg-card p-5">
              <div className="mb-2 font-numeric text-xs uppercase tracking-wide text-long">Token A holder</div>
              <p className="text-sm leading-relaxed text-muted-foreground">Gains when price rises, loses when it falls. Known maximum loss — floors at the threshold, never goes into debt.</p>
            </div>
            <div className="flex-1 rounded-lg border border-border bg-card p-5">
              <div className="mb-2 font-numeric text-xs uppercase tracking-wide text-short">Token B holder</div>
              <p className="text-sm leading-relaxed text-muted-foreground">The mirror. Gains when price falls. Same protections. Their gain is exactly the A holder&apos;s loss, and vice versa.</p>
            </div>
          </div>
          <div className="rounded-lg border border-gold/35 bg-gold/5 px-6 py-5 text-center">
            <div className="font-display text-2xl font-medium">
              <span className="text-long">V<sub>A</sub></span>
              <span className="text-muted-foreground"> + </span>
              <span className="text-short">V<sub>B</sub></span>
              <span className="text-muted-foreground"> = </span>
              <span className="text-gold">K</span>
              <span className="ml-2 text-base text-dim">at every price</span>
            </div>
            <div className="mt-2.5 font-numeric text-sm text-muted-foreground">issuer net exposure = 0 · collateral never impaired</div>
          </div>
        </div>
      );
    case 5:
      return <Rebalancing params={params} />;
    default:
      return <div />;
  }
}

const EYEBROWS = ['Step one · capital', 'Step two · issuance', 'Step three · the venue', 'Step four · mark-to-market', 'The point', 'Edge case · leverage & rebalancing'];
const LEDES = [
  'Capital raised through the Rose Note flows into a single cash collateral pool. Nothing has been bought yet — this is pure, liquid backing capital.',
  'Against the reference price P₀, the treasury mints one long token and one short token of equal value. The pool backs both — never one leg without the other.',
  'Both tokens become tradeable. Every holder of Token A is structurally the counterparty to a holder of Token B — liquidity is built into the instrument.',
  'As price moves, Token A and Token B revalue in real time, in opposite directions. The gold bar — the collateral — never moves. It is always exactly K.',
  'Whatever the price does, the two legs always sum to K. The issuer is delta-neutral by construction — a clearinghouse, not a speculator.',
  'At higher leverage, a large move can push the short leg toward zero. Before it gets there, a threshold rebalance fires — re-anchoring P₀ and saving the leg. Step through it below.',
];

/**
 * The "Coupled Coins" pedagogical walkthrough (mock `coupled-coins.html`): a 6-scene flow with
 * auto-play, a live mark-to-market slider, a threshold-rebalance demo, a progress rail, and keyboard
 * navigation (← / → / Space). Interactive scenes are seeded from a live pair when available, else an
 * explicitly-illustrative example. Honors `prefers-reduced-motion` (no auto-play / transitions).
 */
export function CoupledCoinsWalkthrough({
  livePair,
}: {
  livePair?: WalkthroughParams | null;
}): React.JSX.Element {
  const params = livePair ?? ILLUSTRATIVE;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLElement>(null);

  const go = useCallback((n: number) => setIndex(Math.max(0, Math.min(SCENE_COUNT - 1, n))), []);
  const stop = useCallback(() => setPlaying(false), []);

  // Auto-play: advance scenes on a per-scene dwell, unless reduced-motion. Stops at the last scene.
  useEffect(() => {
    if (!playing || reduced) return;
    const id = window.setTimeout(() => {
      if (index >= SCENE_COUNT - 1) setPlaying(false);
      else setIndex(index + 1);
    }, DWELL_MS[index]);
    return () => window.clearTimeout(id);
  }, [playing, reduced, index]);

  // Keyboard: ← prev, → next (stop auto), Space toggles play — scoped to the walkthrough so it
  // never hijacks the page or the controls/slider it contains. Arrows are ignored while a form
  // field (the price slider) is focused; Space is ignored on focused buttons/links (they activate
  // natively) and only acts when focus is within this section.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target || !containerRef.current?.contains(target)) return;
      const tag = target.tagName;
      const isFormField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'ArrowRight') {
        if (isFormField) return;
        stop();
        setIndex((i) => Math.min(SCENE_COUNT - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        if (isFormField) return;
        stop();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.code === 'Space' || e.key === ' ') {
        if (isFormField || tag === 'BUTTON' || tag === 'A') return;
        e.preventDefault();
        if (reduced) return;
        setPlaying((p) => !p);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reduced, stop]);

  const counter = `${String(index + 1).padStart(2, '0')} / ${String(SCENE_COUNT).padStart(2, '0')}`;

  return (
    <section
      ref={containerRef}
      className="rounded-lg border border-border bg-background p-6"
      aria-label="Coupled-coins walkthrough"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block h-7 w-7 rounded-md bg-[conic-gradient(from_200deg,var(--long),var(--short),var(--gold),var(--long))]"
            aria-hidden
          />
          <span className="font-display text-base font-semibold">Coupled Coins</span>
          <span className="text-xs text-dim">· flow walkthrough</span>
          {params.illustrative && (
            <span className="rounded-full border border-border px-2 py-0.5 font-numeric text-[10px] text-dim">
              illustrative example
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {!reduced && (
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              aria-pressed={playing}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors',
                playing ? 'border-long text-long' : 'border-border text-muted-foreground hover:border-border-strong',
              )}
            >
              <span aria-hidden>{playing ? '❚❚' : '▶'}</span>
              {playing ? 'Pause' : 'Play'}
            </button>
          )}
          <span className="font-numeric text-xs tracking-widest text-dim">{counter}</span>
        </div>
      </div>

      <div className="mt-4 flex gap-1.5" role="group" aria-label="Scenes">
        {SCENE_TITLES.map((title, k) => (
          <button
            key={title}
            type="button"
            aria-current={k === index ? 'step' : undefined}
            aria-controls="coupled-coins-scene"
            aria-label={`Scene ${k + 1}: ${title}`}
            onClick={() => {
              stop();
              go(k);
            }}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors',
              k < index ? 'bg-long' : k === index ? 'bg-blue' : 'bg-border',
            )}
          />
        ))}
      </div>

      <div
        id="coupled-coins-scene"
        className="mt-6 min-h-[380px]"
        role="region"
        aria-live="polite"
        aria-label={`Scene ${index + 1} of ${SCENE_COUNT}: ${SCENE_TITLES[index]}`}
      >
        <div className="font-numeric text-xs uppercase tracking-[0.25em] text-blue">{EYEBROWS[index]}</div>
        <h3 className="mt-2.5 font-display text-2xl font-medium leading-tight">{SCENE_TITLES[index]}</h3>
        <p className="mt-2 max-w-[700px] text-sm leading-relaxed text-muted-foreground">{LEDES[index]}</p>
        <div className="mt-6 flex items-center justify-center">
          <SceneBody index={index} params={params} />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-dim">
          Use <kbd className="rounded border border-border px-1.5 py-0.5 font-numeric text-[11px]">←</kbd>{' '}
          <kbd className="rounded border border-border px-1.5 py-0.5 font-numeric text-[11px]">→</kbd>
          {!reduced && <> · <kbd className="rounded border border-border px-1.5 py-0.5 font-numeric text-[11px]">space</kbd> toggles play</>}
        </span>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => {
              stop();
              go(index - 1);
            }}
            disabled={index === 0}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-strong disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              stop();
              go(index === SCENE_COUNT - 1 ? 0 : index + 1);
            }}
            className="rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            {index === SCENE_COUNT - 1 ? 'Restart' : 'Next'}
          </button>
        </div>
      </div>
    </section>
  );
}
