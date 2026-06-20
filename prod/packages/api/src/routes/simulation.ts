// Simulation settings routes (paper-mode only). Expose the LIVE replay-feed parameters (oscillation
// amplitude + cycle period) so the Simulation screen can read and tune the demo's price dynamics with
// no redeploy. GET returns the current settings (+ version + bounds); PUT validates a patch against the
// bounds (fail-closed: out-of-range ⇒ 400) and bumps the version so the replay oracle rebuilds its
// series. Composed ONLY in `ENGINE_MODE=paper`; a read-only / non-paper deployment returns a typed 503.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError } from '../errors.js';
import {
  ErrorResponseSchema,
  SimulationSettingsUpdateSchema,
  SimulationSettingsViewSchema,
} from '../schemas.js';
import type { SimulationSettingsStore } from '../simulation-settings.js';

/** Resolve the simulation-settings store, or refuse with a typed 503 (composed only in paper mode). */
function requireSimulationSettings(deps: ApiDeps): SimulationSettingsStore {
  if (deps.simulationSettings === undefined) {
    throw new ApiError(
      503,
      'SIMULATION_SETTINGS_UNAVAILABLE',
      'The simulation settings are not configured on this deployment (paper composition not wired). ' +
        'Set ENGINE_MODE=paper for the fully interactive simulated environment.',
    );
  }
  return deps.simulationSettings;
}

export function simulationRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/simulation/settings',
      {
        schema: {
          summary: 'Read the paper replay-feed simulation parameters',
          tags: ['simulation'],
          response: { 200: SimulationSettingsViewSchema, 503: ErrorResponseSchema },
        },
      },
      async () => requireSimulationSettings(deps).get(),
    );

    app.put(
      '/simulation/settings',
      {
        schema: {
          summary: 'Update the paper replay-feed simulation parameters',
          tags: ['simulation'],
          body: SimulationSettingsUpdateSchema,
          response: {
            200: SimulationSettingsViewSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const store = requireSimulationSettings(deps);
        // SimulationSettingsError (out-of-range) is mapped to 400 by the error registry.
        return store.set(request.body);
      },
    );
  };
}
