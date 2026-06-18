// @vitest-environment jsdom
import '../../test/setup.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Home } from './home.js';

describe('Home', () => {
  it('renders the three view cards', () => {
    render(<Home onSelect={() => {}} />);
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('Treasury Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Coupled Coins')).toBeInTheDocument();
  });

  it('calls onSelect with the mapped surface when a card is activated', () => {
    const onSelect = vi.fn();
    render(<Home onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Treasury Dashboard'));
    expect(onSelect).toHaveBeenCalledWith('covenant-console');
  });
});
