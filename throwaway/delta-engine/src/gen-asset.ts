// THROWAWAY — Delta Engine PoC — generates the web static asset for the "Delta Engine" tab.
//
// Runs the default-params simulation and writes the self-contained visualisation to the web app's
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
import { DEFAULT_PARAMS } from './params.js';
import { mulberry32 } from './rng.js';
import { runSimulation } from './simulation.js';
import { toHtml } from './viz.js';

/** Fixed seed so the published asset reproduces exactly. */
const SEED = 12345;

const here = dirname(fileURLToPath(import.meta.url));
// src → delta-engine → throwaway → repo root → prod/packages/web/public/delta-engine.html
const assetPath = resolve(here, '..', '..', '..', 'prod/packages/web/public/delta-engine.html');

mkdirSync(dirname(assetPath), { recursive: true });
const result = runSimulation(DEFAULT_PARAMS, mulberry32(SEED));
writeFileSync(assetPath, toHtml(result), 'utf8');
console.log(`[delta-engine] wrote web asset ${assetPath}`);
