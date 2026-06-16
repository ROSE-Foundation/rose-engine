// GET /health — liveness. No dependencies; a fixed typed response (Story 6.1).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HealthSchema } from '../schemas.js';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    { schema: { summary: 'Liveness probe', tags: ['system'], response: { 200: HealthSchema } } },
    async () => ({ status: 'ok' }) as const,
  );
};
