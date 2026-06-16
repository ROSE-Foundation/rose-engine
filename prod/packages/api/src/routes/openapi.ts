// GET /openapi.json — the generated OpenAPI 3.x document (Story 6.1, AC-1). `@fastify/swagger`
// derives it from the SAME Zod request/response schemas the routes declare (single source of the I/O
// types — no hand-maintained second copy). This route declares no response schema so the (large,
// dynamic) document is serialized as-is rather than re-validated against itself.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export const openApiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/openapi.json',
    { schema: { summary: 'The generated OpenAPI document', tags: ['system'] } },
    async () => app.swagger(),
  );
};
