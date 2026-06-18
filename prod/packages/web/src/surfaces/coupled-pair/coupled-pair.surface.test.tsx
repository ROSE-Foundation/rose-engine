// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { activePair } from '../../test/fixtures.js';

// Drive the surface from a fixed live pair (avoid the react-query/network stack).
vi.mock('../../lib/queries.js', () => ({
  REFRESH_WINDOW_MS: 5000,
  useCoupledPair: () => ({
    data: activePair(),
    isLoading: false,
    isError: false,
    dataUpdatedAt: 1_700_000_000_000,
  }),
}));

const { CoupledPairSurface } = await import('./coupled-pair.js');

describe('CoupledPairSurface', () => {
  it('renders the walkthrough and the live CoupledPairView together', () => {
    render(<CoupledPairSurface pairId="p1" />);
    // The pedagogical walkthrough...
    expect(screen.getByLabelText('Coupled-coins walkthrough')).toBeInTheDocument();
    // ...above the preserved live-data view (FR-6).
    expect(screen.getByText(/Coupled pair · BTC/)).toBeInTheDocument();
    // A live pair is seeded, so the walkthrough is NOT labelled illustrative.
    expect(screen.queryByText('illustrative example')).not.toBeInTheDocument();
  });
});
