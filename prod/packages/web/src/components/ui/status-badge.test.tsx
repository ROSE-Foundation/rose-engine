// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, type BadgeStatus } from './status-badge.js';

const ALL: BadgeStatus[] = [
  'PENDING',
  'ACTIVE',
  'REBALANCING',
  'PARTIAL',
  'SETTLING',
  'CLOSED',
  'live',
  'divergent',
  'pending',
];

describe('StatusBadge', () => {
  it('renders a non-empty label for every lifecycle + consistency status (never color-only)', () => {
    for (const status of ALL) {
      const { unmount } = render(<StatusBadge status={status} />);
      const badge = screen.getByRole('status');
      expect(badge.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      unmount();
    }
  });

  it('uses the pill (rounded-full) radius reserved for status badges', () => {
    render(<StatusBadge status="ACTIVE" />);
    expect(screen.getByRole('status')).toHaveClass('rounded-full');
  });

  it('announces the state to screen readers', () => {
    render(<StatusBadge status="REBALANCING" />);
    expect(screen.getByLabelText('Status: Rebalancing')).toBeInTheDocument();
  });
});
