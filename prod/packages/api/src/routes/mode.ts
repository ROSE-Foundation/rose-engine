// GET /mode — the running engine mode + an honest real-vs-mocked summary (Story 9.6, FR-33). UNLIKE
// the faithful-gated routes this is ALWAYS available (it reports the mode, it does not depend on it):
// a read-only / paper / faithful deployment each returns its own accurate report. The mode is DERIVED
// FROM THE ACTUAL COMPOSED DEPS (`deriveEngineMode`), so it can never drift from what the server wired.
// Behind the same one basic-auth gate as every other route (added in `serve.ts buildServer`).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { deriveEngineMode } from '../engine-mode.js';
import { EngineModeInfoSchema } from '../schemas.js';

export function modeRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/mode',
      {
        schema: {
          summary: 'Report the running engine mode + an honest real-vs-mocked summary (FR-33)',
          tags: ['system'],
          response: { 200: EngineModeInfoSchema },
        },
      },
      async () => deriveEngineMode(deps),
    );
  };
}
