// THROWAWAY — Delta Engine PoC — tests for the self-contained HTML visualisation generator.
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from './params.js';
import { mulberry32 } from './rng.js';
import { runSimulation } from './simulation.js';
import { toHtml } from './viz.js';

describe('toHtml', () => {
  const result = runSimulation({ ...DEFAULT_PARAMS, T: 80 }, mulberry32(7));
  const html = toHtml(result);

  it('produces a self-contained HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // No external resources: no <link>/<script src>/CDN — everything inlined.
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]*\bhref=/i);
  });

  it('inlines the run payload (params + every series row)', () => {
    expect(html).toContain('const DATA =');
    expect(html).toContain('"series"');
    expect(html).toContain(`"finalTick":${result.finalTick}`);
    // One JSON object per recorded tick (pInt appears once per row).
    const rows = (html.match(/"pInt":/g) ?? []).length;
    expect(rows).toBe(result.series.length);
  });

  it('renders all six chart canvases', () => {
    for (const id of ['c_price', 'c_cap', 'c_alive', 'c_queue', 'c_matched', 'c_hist']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('leaks no unresolved template interpolation into the output', () => {
    expect(html).not.toContain('${');
  });
});
