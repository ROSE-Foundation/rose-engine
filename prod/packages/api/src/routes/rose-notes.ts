// GET /rose-notes/:id — read one Rose Note (Story 6.1). `:id` Zod-validated as a UUID (malformed ⇒
// 400); an absent (well-formed) id ⇒ 404 structured error.
import { getRoseNote } from '@rose/ledger';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { NotFoundError } from '../errors.js';
import { ErrorResponseSchema, IdParamSchema, RoseNoteSchema } from '../schemas.js';
import { serializeRoseNote } from '../serializers.js';

export function roseNoteRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/rose-notes/:id',
      {
        schema: {
          summary: 'Read a Rose Note by id',
          tags: ['read'],
          params: IdParamSchema,
          response: { 200: RoseNoteSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const note = await getRoseNote(deps.db, id);
        if (note === null) {
          throw new NotFoundError(`Rose Note '${id}' not found.`, { id });
        }
        return serializeRoseNote(note);
      },
    );
  };
}
