// Rose Note redemption write endpoints (Story 6.3, FR-11) — the live (paper/testnet) redeem flow
// branching onto the 6.1 typed boundary, the INVERSE mirror of the 6.2 subscription endpoints.
// `POST /rose-notes/:id/redemptions` drives the injected `RedemptionService` (the `@rose/rose-note`
// composition layer); `GET /redemptions/:id` reads the pending/confirmed status (the "pending until
// commit point" surface, where the position closes on confirm). The route holds no chain/ledger logic
// — it validates I/O (Zod), maps money to/from smallest-units STRINGS (NFR-2), and lets domain/
// authorization refusals surface through the 6.1 structured-error translator (authorization DENY ⇒
// 403 / REFUSE ⇒ 422, lifecycle/idempotency ⇒ 409, not-found ⇒ 404, validation ⇒ 400). When the
// service is not composed (read-only deployment / paper not wired) the write path is a typed 503
// (refuse-if-absent).
import type { RedemptionView } from '@rose/rose-note';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError, NotFoundError } from '../errors.js';
import {
  ErrorResponseSchema,
  IdParamSchema,
  RedeemRequestSchema,
  RedemptionIdParamSchema,
  RedemptionSchema,
} from '../schemas.js';

/** Serialize a `RedemptionView` for the wire: the `amount` bigint → smallest-units string (NFR-2). */
function serializeRedemption(view: RedemptionView): {
  id: string;
  roseNoteId: string;
  coupledPairId: string;
  redeemer: string;
  amount: string;
  paymentAsset: string;
  status: 'pending' | 'confirmed' | 'failed';
  txHash: string | null;
  journalEntryId: string | null;
} {
  return {
    id: view.id,
    roseNoteId: view.roseNoteId,
    coupledPairId: view.coupledPairId,
    redeemer: view.redeemer,
    amount: view.amount.toString(),
    paymentAsset: view.paymentAsset,
    status: view.status,
    txHash: view.txHash,
    journalEntryId: view.journalEntryId,
  };
}

function requireService(deps: ApiDeps): NonNullable<ApiDeps['redemptions']> {
  if (deps.redemptions === undefined) {
    throw new ApiError(
      503,
      'REDEMPTION_SERVICE_UNAVAILABLE',
      'The redemption service is not configured on this deployment (paper/live composition not wired).',
    );
  }
  return deps.redemptions;
}

export function redemptionRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/rose-notes/:id/redemptions',
      {
        schema: {
          summary: 'Redeem a Rose Note (paired burn, paper/testnet)',
          tags: ['write'],
          params: IdParamSchema,
          body: RedeemRequestSchema,
          response: {
            201: RedemptionSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            422: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const service = requireService(deps);
        const { id } = request.params;
        const body = request.body;
        const view = await service.redeem({
          roseNoteId: id,
          redeemer: body.redeemer,
          amount: BigInt(body.amount),
          paymentAsset: body.paymentAsset,
          idempotencyKey: body.idempotencyKey,
        });
        reply.status(201);
        return serializeRedemption(view);
      },
    );

    app.get(
      '/redemptions/:id',
      {
        schema: {
          summary: 'Read a redemption status (pending until the on-chain commit point)',
          tags: ['read'],
          params: RedemptionIdParamSchema,
          response: { 200: RedemptionSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) => {
        const service = requireService(deps);
        const { id } = request.params;
        const view = await service.getRedemption(id);
        if (view === null) {
          throw new NotFoundError(`Redemption '${id}' not found.`, { id });
        }
        return serializeRedemption(view);
      },
    );
  };
}
