// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../../lib/api-client.js';
import type { SimulationSettingsUpdate } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import {
  simulationSettings,
  simulationSettingsRangeError,
  simulationSettingsUnavailableError,
} from '../../test/fixtures.js';
import { SimulationSurface } from './simulation.js';

function wrap(client: Partial<ApiClient>, ui: ReactNode): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>{ui}</ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('SimulationSurface — read + tune the paper replay-feed parameters', () => {
  it('renders the current settings + version from the fixture', async () => {
    const getSimulationSettings = vi.fn(() => Promise.resolve(simulationSettings()));
    render(wrap({ getSimulationSettings }, <SimulationSurface />));

    // The current amplitude (0.07) renders both raw and as a percentage; the version is surfaced.
    expect(await screen.findByText(/7%/)).toBeInTheDocument();
    expect(screen.getByText(/current version 1/i)).toBeInTheDocument();
    const amplitude = screen.getByLabelText<HTMLInputElement>('Amplitude value');
    expect(amplitude.value).toBe('0.07');
  });

  it('changing a control + Apply calls PUT /simulation/settings with the right body', async () => {
    const getSimulationSettings = vi.fn(() => Promise.resolve(simulationSettings()));
    const updateSimulationSettings = vi.fn<
      (patch: SimulationSettingsUpdate) => Promise<ReturnType<typeof simulationSettings>>
    >(() => Promise.resolve(simulationSettings({ amplitude: 0.2, version: 2 })));
    render(wrap({ getSimulationSettings, updateSimulationSettings }, <SimulationSurface />));

    const amplitude = await screen.findByLabelText<HTMLInputElement>('Amplitude value');
    await userEvent.clear(amplitude);
    await userEvent.type(amplitude, '0.2');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(updateSimulationSettings).toHaveBeenCalledTimes(1);
    const body = updateSimulationSettings.mock.calls[0]![0];
    // The raw fraction is submitted (NOT the percentage); the period rides along unchanged.
    expect(body.amplitude).toBe(0.2);
    expect(body.periodSeconds).toBe(120);
    // On success the freshly-applied version is confirmed.
    expect(await screen.findByText(/applied — version 2/i)).toBeInTheDocument();
  });

  it('shows the DIVERGENT hint when amplitude × 3 ≥ 1 (not blocked)', async () => {
    const getSimulationSettings = vi.fn(() => Promise.resolve(simulationSettings()));
    render(wrap({ getSimulationSettings }, <SimulationSurface />));

    const amplitude = await screen.findByLabelText<HTMLInputElement>('Amplitude value');
    expect(screen.queryByText(/DIVERGENT mark/i)).not.toBeInTheDocument();
    await userEvent.clear(amplitude);
    await userEvent.type(amplitude, '0.34');
    expect(screen.getByText(/DIVERGENT mark/i)).toBeInTheDocument();
    // Not blocked: Apply stays enabled.
    expect(screen.getByRole('button', { name: /apply/i })).toBeEnabled();
  });

  it('renders the clean "not available" state when the GET returns 503 (non-paper)', async () => {
    const getSimulationSettings = vi.fn(() => Promise.reject(simulationSettingsUnavailableError()));
    render(wrap({ getSimulationSettings }, <SimulationSurface />));

    expect(
      await screen.findByText(/not available on this deployment \(paper mode only\)/i),
    ).toBeInTheDocument();
    // No editable form when settings are unavailable.
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
  });

  it('surfaces the typed 400 message when a PUT is refused (out-of-range)', async () => {
    const getSimulationSettings = vi.fn(() => Promise.resolve(simulationSettings()));
    const updateSimulationSettings = vi.fn(() => Promise.reject(simulationSettingsRangeError()));
    render(wrap({ getSimulationSettings, updateSimulationSettings }, <SimulationSurface />));

    await screen.findByLabelText('Amplitude value');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/amplitude must be within/i);
    expect(alert).toHaveTextContent(/SimulationSettingsError/);
  });
});
