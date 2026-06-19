// @vitest-environment jsdom
import '../../../test/setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoupledCoinsWalkthrough } from './coupled-coins-walkthrough.js';

afterEach(() => {
  // Reset any matchMedia stub between tests.
  // @ts-expect-error -- test cleanup of the optional jsdom global
  delete window.matchMedia;
});

describe('CoupledCoinsWalkthrough', () => {
  it('renders the first scene and disables Back at the start', () => {
    render(<CoupledCoinsWalkthrough />);
    expect(
      screen.getByRole('heading', { name: /Investors fund the Rose Note/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('01 / 06')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    // No live pair ⇒ explicitly labelled illustrative.
    expect(screen.getByText('illustrative example')).toBeInTheDocument();
  });

  it('advances scenes with Next and via the rail tabs', () => {
    render(<CoupledCoinsWalkthrough />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('02 / 06')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /mints a matched pair/ })).toBeInTheDocument();
    // Jump straight to the mark-to-market scene via its rail tab.
    fireEvent.click(screen.getByRole('button', { name: /Scene 4:/ }));
    expect(screen.getByText('04 / 06')).toBeInTheDocument();
  });

  it('keeps V_A + V_B = K when the mark-to-market price slider moves', () => {
    render(<CoupledCoinsWalkthrough />);
    fireEvent.click(screen.getByRole('button', { name: /Scene 4:/ }));
    const slider = screen.getByRole('slider', { name: /Price move off anchor/ });
    fireEvent.change(slider, { target: { value: '1000' } }); // +10%
    // Illustrative K = 1,000,000; at +10% L=1 ⇒ long 550,000 / short 450,000, sum still K.
    expect(screen.getByLabelText('invariant holds')).toBeInTheDocument();
    expect(screen.getByText('550,000 units')).toBeInTheDocument();
    expect(screen.getByText('450,000 units')).toBeInTheDocument();
  });

  it('seeds the scenes from a live pair (no illustrative label) and advances to rebalancing', () => {
    render(
      <CoupledCoinsWalkthrough
        livePair={{
          referenceAsset: 'BTC/USD',
          anchorPrice: '60000.00',
          leverage: '3',
          collateralPool: '20000',
          floor: '0.6',
          illustrative: false,
        }}
      />,
    );
    expect(screen.queryByText('illustrative example')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Scene 6:/ }));
    expect(screen.getByText('06 / 06')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reset fires/ })).toBeInTheDocument();
  });

  it('auto-advances while playing and stops when paused', () => {
    vi.useFakeTimers();
    try {
      render(<CoupledCoinsWalkthrough />);
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      });
      expect(screen.getByText('01 / 06')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(6000); // scene-1 dwell
      });
      expect(screen.getByText('02 / 06')).toBeInTheDocument();
      // Pause halts further advance.
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      });
      act(() => {
        vi.advanceTimersByTime(20000);
      });
      expect(screen.getByText('02 / 06')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses auto-play (no Play control) under prefers-reduced-motion', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    render(<CoupledCoinsWalkthrough />);
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    // Manual navigation still works.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('02 / 06')).toBeInTheDocument();
  });
});
