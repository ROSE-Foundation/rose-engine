// THROWAWAY — generates the web static asset for the "Delta Engine" tab.
//
// Runs the package's emergent-price MARKET simulator to produce a price series, runs the FULL DELTA
// ENGINE strategy (paper §5) on it, and writes the self-contained visualisation to the web app's
// public dir as `prod/packages/web/public/delta-engine.html`. The web surface embeds it via an
// <iframe>, so /prod serves a STATIC FILE and imports NO /throwaway code — the regime boundary
// (/prod must never import /throwaway) is preserved (writing a static asset is not a code import).
//
// Run from the repo root:
//   pnpm exec tsx throwaway/delta-engine/src/gen-asset.ts
//
// REGIME: lives under /throwaway (so it may import the throwaway package); Node stdlib only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeltaEngine, DEFAULT_DELTA_CONFIG } from './delta-engine.js';
import { sampleSeries } from './sample-series.js';
import { toDeltaHtml } from './delta-viz.js';

/** Fixed seed so the published asset reproduces exactly. */
const SEED = DEFAULT_DELTA_CONFIG.seed;
const TICKS = 1200;

const here = dirname(fileURLToPath(import.meta.url));
// src → delta-engine → throwaway → repo root → prod/packages/web/public/delta-engine.html
const assetPath = resolve(here, '..', '..', '..', 'prod/packages/web/public/delta-engine.html');

mkdirSync(dirname(assetPath), { recursive: true });
// Price source: a deterministic, seeded FX-like sample series (the emergent p_int is a sticky step
// function — too degenerate to legibly showcase a DC strategy; run-delta.ts demonstrates trading the
// emergent market). The FULL Delta Engine then trades this series.
const prices = sampleSeries(SEED, TICKS);
const result = runDeltaEngine({ prices, seed: SEED });
writeFileSync(assetPath, toDeltaHtml(result), 'utf8');
console.log(
  `[delta-engine] wrote web asset ${assetPath} ` +
    `(ticks=${result.summary.ticks} trades=${result.summary.trades} dc=${result.summary.dcEvents})`,
);
