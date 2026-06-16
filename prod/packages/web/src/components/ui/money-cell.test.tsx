// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Money } from '../../lib/contract-types.js';
import { MoneyCell } from './money-cell.js';

const nav: Money = {
  asset: 'EUR',
  scale: 2,
  smallestUnits: '1248033000',
  decimal: '12480330.00',
};

describe('MoneyCell', () => {
  it('renders the exact decimal string with its asset symbol (never a parsed number)', () => {
    render(<MoneyCell money={nav} />);
    expect(screen.getByText('12480330.00')).toBeInTheDocument();
    expect(screen.getByText('EUR')).toBeInTheDocument();
  });

  it('announces value + unit + scale to screen readers and is tabular mono right-aligned', () => {
    render(<MoneyCell money={nav} />);
    const cell = screen.getByLabelText('12480330.00 EUR (scale 2)');
    expect(cell).toHaveClass('font-numeric');
    expect(cell).toHaveClass('tabular-nums');
    expect(cell).toHaveClass('text-right');
    // No truncation/ellipsis on a monetary value (UX-DR2).
    expect(cell.className).not.toContain('truncate');
  });

  it('renders the smallest-units only as a non-displayed title, never as the money figure', () => {
    render(<MoneyCell money={nav} />);
    const cell = screen.getByLabelText('12480330.00 EUR (scale 2)');
    expect(cell).toHaveAttribute('title', '1248033000 smallest units');
    expect(cell).not.toHaveTextContent('1248033000');
  });
});
