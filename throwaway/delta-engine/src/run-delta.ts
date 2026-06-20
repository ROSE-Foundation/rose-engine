// THROWAWAY — runnable entrypoint for the DELTA ENGINE trading strategy (paper §5).
//
// Generates a price series from the package's own emergent-price MARKET simulator (the Dutch-auction
// p_int), then runs the FULL Delta Engine on it and writes the per-tick series + trades to CSV/JSON
// and a self-contained HTML visualisation under throwaway/delta-engine/out/. Run from the repo root:
//   pnpm exec tsx throwaway/delta-engine/src/run-delta.ts
//
// REGIME: lives under /throwaway, Node stdlib only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS } from './params.js';
import { mulberry32 } from './rng.js';
import { runSimulation } from './simulation.js';
import {
  runDeltaEngine,
  deltaToCsv,
  deltaToJson,
  DEFAULT_DELTA_CONFIG,
  type DeltaResult,
} from './delta-engine.js';
import { sampleSeries } from './sample-series.js';
import { toDeltaHtml } from './delta-viz.js';

const SEED = DEFAULT_DELTA_CONFIG.seed;
const TICKS = 1200;

function summaryLine(label: string, r: DeltaResult): string {
  const s = r.summary;
  return (
    `[delta-engine] ${label}: ticks=${s.ticks} dcEvents=${s.dcEvents} ` +
    `trades=${s.trades} (reversals=${s.reversals}) maxAbsExposure=${s.maxAbsExposure} ` +
    `finalNet=${s.finalNetExposure} silencedTicks=${s.silencedTickCount} ` +
    `mtmPnL=${s.markToMarketPnl.toFixed(4)}`
  );
}

function main(): void {
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');
  mkdirSync(outDir, { recursive: true });

  // (1) Primary demo: a deterministic, seeded FX-like SAMPLE series (rich DC structure at every
  // scale). The full Delta Engine trades it; this drives the CSV/JSON/HTML outputs.
  const sample = runDeltaEngine({ prices: sampleSeries(SEED, TICKS), seed: SEED });
  writeFileSync(resolve(outDir, 'delta-series.csv'), deltaToCsv(sample.series), 'utf8');
  writeFileSync(resolve(outDir, 'delta-series.json'), deltaToJson(sample), 'utf8');
  writeFileSync(resolve(outDir, 'delta-index.html'), toDeltaHtml(sample), 'utf8');

  // (2) Wiring demo: the Delta Engine ALSO trades the package's OWN emergent market — the
  // Dutch-auction endogenous price p_int — proving the strategy runs on the simulator's output.
  const sim = runSimulation({ ...DEFAULT_PARAMS, T: 10_000 }, mulberry32(SEED));
  const emergent = runDeltaEngine({ prices: sim.series.map((r) => r.pInt), seed: SEED });
  writeFileSync(resolve(outDir, 'delta-emergent.json'), deltaToJson(emergent), 'utf8');

  console.log(summaryLine('sample', sample));
  console.log(summaryLine('emergent p_int', emergent));
  console.log(`[delta-engine] wrote ${resolve(outDir, 'delta-series.csv')}`);
  console.log(`[delta-engine] wrote ${resolve(outDir, 'delta-series.json')}`);
  console.log(`[delta-engine] wrote ${resolve(outDir, 'delta-index.html')}  (open in a browser)`);
  console.log(`[delta-engine] wrote ${resolve(outDir, 'delta-emergent.json')}`);
}

main();
