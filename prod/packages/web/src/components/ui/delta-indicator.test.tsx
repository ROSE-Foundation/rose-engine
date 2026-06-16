// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeltaIndicator } from './delta-indicator.js';

describe('DeltaIndicator', () => {
  it('shows an up glyph + plus sign + gain color for a positive delta', () => {
    render(<DeltaIndicator direction="up" label="0.4%" />);
    const el = screen.getByLabelText('up 0.4%');
    expect(el).toHaveClass('text-gain');
    expect(el).toHaveTextContent('▴');
    expect(el).toHaveTextContent('+0.4%');
  });

  it('shows a down glyph + minus sign + loss color for a negative delta', () => {
    render(<DeltaIndicator direction="down" label="1.2%" />);
    const el = screen.getByLabelText('down 1.2%');
    expect(el).toHaveClass('text-loss');
    expect(el).toHaveTextContent('▾');
    expect(el).toHaveTextContent('−1.2%');
  });

  it('never signals by color alone — the glyph + sign carry the meaning', () => {
    const { container } = render(<DeltaIndicator direction="up" label="0.4%" />);
    // The visible text contains a non-color glyph token.
    expect(container.textContent).toContain('▴');
  });
});
