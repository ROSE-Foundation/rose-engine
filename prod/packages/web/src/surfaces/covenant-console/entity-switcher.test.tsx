// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EntitySwitcher } from './entity-switcher.js';

describe('EntitySwitcher', () => {
  it('marks the active scope pressed and reports a new scope on click', async () => {
    const onChange = vi.fn();
    render(<EntitySwitcher value="consolidated" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Consolidated' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'TRADING_CO' }));
    expect(onChange).toHaveBeenCalledWith('TRADING_CO');
  });

  it('offers consolidated + the four fixed entities', () => {
    render(<EntitySwitcher value="VCC" onChange={() => {}} />);
    for (const name of ['Consolidated', 'VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
