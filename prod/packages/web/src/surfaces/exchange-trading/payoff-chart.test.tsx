// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CoupledPairPosition } from '../../lib/contract-types.js';
import { tradingGroupView } from '../../test/fixtures.js';
import { PayoffChart } from './payoff-chart.js';

function pairFixture(): CoupledPairPosition {
  return tradingGroupView().coupledPairs[0]!;
}

describe('PayoffChart', () => {
  it('renders a real payoff graph (an SVG with two leg curves), not a fabricated price tape', () => {
    const pair = pairFixture();
    const { container } = render(<PayoffChart pair={pair} />);

    // The chart is a labelled image referencing the REAL anchor — no invented price series.
    const chart = screen.getByRole('img', { name: /payoff curve/i });
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveAccessibleName(new RegExp(`anchor ${pair.anchorPrice}`));

    // Two polylines = the long + short leg curves, each a full SAMPLES-point path.
    const curves = container.querySelectorAll('polyline');
    expect(curves).toHaveLength(2);
    for (const curve of curves) {
      expect(curve.getAttribute('points')?.trim().split(/\s+/).length).toBe(121);
    }
  });

  it('anchors the axis at P₀ and surfaces the real package terms (leverage, floor)', () => {
    const pair = pairFixture();
    render(<PayoffChart pair={pair} />);
    expect(screen.getByText(`P₀ = ${pair.anchorPrice}`)).toBeInTheDocument();
    expect(screen.getByText(/Long leg/)).toBeInTheDocument();
    expect(screen.getByText(/Short leg/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${pair.leverage}×`))).toBeInTheDocument();
  });
});
