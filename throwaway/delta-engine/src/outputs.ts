// THROWAWAY — Delta Engine PoC (docs/alpha_engine_poc_v1.pdf), §18 "Required Outputs".
//
// Serialises the recorded per-tick series to CSV and JSON. The five §18 series (p_int, queue_depth,
// alive_count, total_capital, matched_volume) live across the SeriesRow columns, with long/short
// splits where the spec asks for them.
//
// REGIME: lives under /throwaway, Node stdlib only.
import type { SeriesRow, SimResult } from './simulation.js';

/** CSV column order — one column per §18 series (long/short split where applicable). */
export const SERIES_COLUMNS = [
  't',
  'p_int',
  'queue_depth_long',
  'queue_depth_short',
  'alive_long',
  'alive_short',
  'total_capital',
  'matched_volume',
] as const;

/** Serialises the series to CSV text (header row + one row per tick). */
export function toCsv(series: readonly SeriesRow[]): string {
  const lines: string[] = [SERIES_COLUMNS.join(',')];
  for (const r of series) {
    lines.push(
      [
        r.t,
        r.pInt,
        r.queueDepthLong,
        r.queueDepthShort,
        r.aliveLong,
        r.aliveShort,
        r.totalCapital,
        r.matchedVolume,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Serialises the full run (params, termination info, series) to pretty JSON text. */
export function toJson(result: SimResult): string {
  return (
    JSON.stringify(
      {
        params: result.params,
        finalTick: result.finalTick,
        reason: result.reason,
        series: result.series,
      },
      null,
      2,
    ) + '\n'
  );
}
