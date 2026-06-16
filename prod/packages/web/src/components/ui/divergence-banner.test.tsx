// @vitest-environment jsdom
import '../../test/setup.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChainComparison } from '../../lib/contract-types.js';
import { DivergenceBanner } from './divergence-banner.js';

const money = (asset: string) => ({ asset, scale: 0, smallestUnits: '0', decimal: '0' });

const reconciled: ChainComparison = {
  source: 'ledger+chain',
  divergences: [],
  anyDivergence: false,
};

const diverged: ChainComparison = {
  source: 'ledger+chain',
  anyDivergence: true,
  divergences: [
    {
      asset: 'ROSE-L',
      scale: 0,
      ledgerQuantity: money('ROSE-L'),
      onChainTotalSupply: money('ROSE-L'),
      divergence: money('ROSE-L'),
      diverged: true,
    },
  ],
};

describe('DivergenceBanner', () => {
  it('renders nothing when there is no divergence', () => {
    const { container } = render(<DivergenceBanner chainComparison={reconciled} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the correction-toward-chain with a glyph and names the asset', () => {
    render(<DivergenceBanner chainComparison={diverged} />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Ledger ↔ chain divergence detected on ROSE-L');
    expect(banner).toHaveTextContent('corrected toward chain');
    expect(banner.textContent).toContain('⚠');
  });

  it('links to the journaled correcting entry', () => {
    const onView = vi.fn();
    render(
      <DivergenceBanner
        chainComparison={diverged}
        correctingEntryId="entry-42"
        onViewEntry={onView}
      />,
    );
    fireEvent.click(screen.getByText('View entry'));
    expect(onView).toHaveBeenCalledWith('entry-42');
  });
});
