// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { activePair, rebalancingPair } from '../../test/fixtures.js';
import { CoupledPairView } from './coupled-pair.js';

const BASE = new Date('2026-06-16T12:00:00Z').getTime();

describe('CoupledPairView', () => {
  it('renders the leg values, K, floor, anchor and the V_A + V_B = K invariant', () => {
    render(<CoupledPairView pair={activePair()} lastUpdated={BASE} now={BASE + 1000} />);
    expect(screen.getByLabelText('long leg 10000')).toBeInTheDocument();
    expect(screen.getByLabelText('short leg 10000')).toBeInTheDocument();
    expect(screen.getByLabelText('V_A plus V_B equals K')).toHaveTextContent('V_A + V_B = K');
    // anchor P₀ shown; floor shown with its derived units (6000 for K=20000, f=0.6).
    expect(screen.getByText('60000.00')).toBeInTheDocument();
    expect(screen.getByText(/6000 units/)).toBeInTheDocument();
  });

  it('reflects the live lifecycle state in the status badge', () => {
    render(<CoupledPairView pair={rebalancingPair()} lastUpdated={BASE} now={BASE + 1000} />);
    expect(screen.getByLabelText('Status: Rebalancing')).toBeInTheDocument();
  });

  it('shows distance-to-floor and warns when the losing leg nears/breaches the floor', () => {
    // rebalancing fixture: long 5000 / short 15000, floorUnits 6000 ⇒ distance -1000 (breached).
    render(<CoupledPairView pair={rebalancingPair()} lastUpdated={BASE} now={BASE + 1000} />);
    const dist = screen.getByLabelText('distance to floor -1000');
    expect(dist).toHaveClass('text-warn');
    expect(dist).toHaveTextContent('breached');
  });

  it('flips the live indicator to stale when data ages beyond the refresh window', () => {
    render(
      <CoupledPairView
        pair={activePair()}
        lastUpdated={BASE}
        refreshWindowMs={5000}
        now={BASE + 60_000}
      />,
    );
    expect(screen.getByText(/Stale · last updated/)).toBeInTheDocument();
  });
});
