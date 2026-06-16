// GET /coupled-pairs/:id — read one coupled pair (Story 6.1). `:id` is Zod-validated as a UUID (a
// malformed id ⇒ 400 at the boundary); an absent (well-formed) id ⇒ 404 structured error. Money
// magnitudes K/V_A/V_B cross as raw smallest-unit integer strings (NFR-2).
import { getCoupledPair } from '@rose/ledger';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { NotFoundError } from '../errors.js';
import { CoupledPairSchema, ErrorResponseSchema, IdParamSchema } from '../schemas.js';
import { serializeCoupledPair } from '../serializers.js';

export function coupledPairRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/coupled-pairs/:id',
      {
        schema: {
          summary: 'Read a coupled pair by id',
          tags: ['read'],
          params: IdParamSchema,
          response: { 200: CoupledPairSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const pair = await getCoupledPair(deps.db, id);
        if (pair === null) {
          throw new NotFoundError(`Coupled pair '${id}' not found.`, { id });
        }
        return serializeCoupledPair(pair);
      },
    );
  };
}
