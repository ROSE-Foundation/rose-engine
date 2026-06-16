// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from './stat-card.js';

describe('StatCard', () => {
  it('renders a label, a figure, and an optional delta', () => {
    render(
      <StatCard
        label="Group NAV"
        figure={<span>€ 12,480,330.00</span>}
        delta={<span>▴ +0.4%</span>}
      />,
    );
    expect(screen.getByText('Group NAV')).toBeInTheDocument();
    expect(screen.getByText('€ 12,480,330.00')).toBeInTheDocument();
    expect(screen.getByText('▴ +0.4%')).toBeInTheDocument();
  });
});
