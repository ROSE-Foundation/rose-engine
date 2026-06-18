// THROWAWAY — Alpha Engine PoC (docs/alpha_engine_poc_v1.pdf) — runnable entrypoint.
//
// Runs the simulation with DEFAULT_PARAMS (Part VIII) under a fixed seed and writes the five §18
// series to CSV + JSON under throwaway/alpha-engine/out/. Run from the repo root:
//   pnpm exec tsx throwaway/alpha-engine/src/run.ts
//
// REGIME: lives under /throwaway, Node stdlib only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS } from './params.js';
import { mulberry32 } from './rng.js';
import { runSimulation } from './simulation.js';
import { toCsv, toJson } from './outputs.js';
import { toHtml } from './viz.js';

/** Fixed seed so the default run reproduces exactly. */
const DEFAULT_SEED = 12345;

function main(): void {
  const rng = mulberry32(DEFAULT_SEED);
  const result = runSimulation(DEFAULT_PARAMS, rng);

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');
  mkdirSync(outDir, { recursive: true });

  const csvPath = resolve(outDir, 'series.csv');
  const jsonPath = resolve(outDir, 'series.json');
  const htmlPath = resolve(outDir, 'index.html');
  writeFileSync(csvPath, toCsv(result.series), 'utf8');
  writeFileSync(jsonPath, toJson(result), 'utf8');
  writeFileSync(htmlPath, toHtml(result), 'utf8');

  const last = result.series.at(-1);
  console.log(
    `[alpha-engine] seed=${DEFAULT_SEED} ticks=${result.finalTick} reason=${result.reason}`,
  );
  if (last !== undefined) {
    console.log(
      `[alpha-engine] final: p_int=${last.pInt.toFixed(6)} ` +
        `alive=${last.aliveLong}L/${last.aliveShort}S total_capital=${last.totalCapital.toFixed(2)}`,
    );
  }
  console.log(`[alpha-engine] wrote ${csvPath}`);
  console.log(`[alpha-engine] wrote ${jsonPath}`);
  console.log(`[alpha-engine] wrote ${htmlPath}  (open in a browser)`);
}

main();
