// THROWAWAY — tests for the Delta Engine HTML visualisation generator.
import { describe, it, expect } from 'vitest';
import { runDeltaEngine } from './delta-engine.js';
import { toDeltaHtml } from './delta-viz.js';

function multiFreqSeries(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(100 + 12 * Math.sin(i / 40) + 4 * Math.sin(i / 3.3) + 1.5 * Math.sin(i / 1.7));
  }
  return out;
}

describe('toDeltaHtml', () => {
  const result = runDeltaEngine({ prices: multiFreqSeries(300) });
  const html = toDeltaHtml(result);

  it('produces a self-contained HTML document with no external resources', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]*\bhref=/i);
  });

  it('inlines the run payload and renders the three Delta Engine canvases', () => {
    expect(html).toContain('const DATA =');
    expect(html).toContain('"exposure"');
    for (const id of ['c_price', 'c_exp', 'c_sil']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('leaks no unresolved template interpolation into the output', () => {
    expect(html).not.toContain('${');
  });
});
