// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiveIndicator } from './live-indicator.js';

const BASE = new Date('2026-06-16T12:00:00Z').getTime();

describe('LiveIndicator', () => {
  it('reads "Live" with the gain color while within the refresh window', () => {
    render(<LiveIndicator lastUpdated={BASE} refreshWindowMs={5000} now={BASE + 1000} />);
    const el = screen.getByText('Live');
    expect(el.parentElement).toHaveClass('text-gain');
  });

  it('flips to stale (warn + last-updated) once data ages beyond the window', () => {
    render(<LiveIndicator lastUpdated={BASE} refreshWindowMs={5000} now={BASE + 60_000} />);
    const el = screen.getByText(/Stale · last updated/);
    expect(el.parentElement).toHaveClass('text-warn');
  });

  it('announces freshness politely via aria-live', () => {
    const { container } = render(
      <LiveIndicator lastUpdated={BASE} refreshWindowMs={5000} now={BASE + 1000} />,
    );
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
