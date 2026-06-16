// @vitest-environment jsdom
import '../test/setup.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme-provider.js';

function Probe(): React.JSX.Element {
  const { mode, toggle } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button type="button" onClick={toggle}>
        toggle
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to light and persists the toggled mode to localStorage', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    fireEvent.click(screen.getByText('toggle'));

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem('rose-theme')).toBe('dark');
  });

  it('reads a previously persisted mode on mount', () => {
    window.localStorage.setItem('rose-theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
