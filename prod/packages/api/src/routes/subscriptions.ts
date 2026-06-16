// Rose Note subscription write endpoints (Story 6.2, FR-11) — the live (paper/testnet) subscribe
// flow branching onto the 6.1 typed boundary. `POST /rose-notes/:id/subscriptions` drives the
// injected `SubscriptionService` (the `@rose/rose-note` composition layer); `GET /subscriptions/:id`
// reads the pending/confirmed status (the "pending until commit point" surface). The route holds no
// chain/ledger logic — it validates I/O (Zod), maps money to/from smallest-units STRINGS (NFR-2),
// and lets domain/authorization refusals surface through the 6.1 structured-error translator
// (eligibility ⇒ 403, lifecycle ⇒ 409, not-found ⇒ 404, validation ⇒ 400). When the service is not
// composed (read-only deployment / paper not wired) the write path is a typed 503 (refuse-if-absent).
import type { SubscriptionView } from '@rose/rose-note';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError, NotFoundError } from '../errors.js';
import {
  ErrorResponseSchema,
  IdParamSchema,
  SubscribeRequestSchema,
  SubscriptionIdParamSchema,
  SubscriptionSchema,
} from '../schemas.js';

/** Serialize a `SubscriptionView` for the wire: the `amount` bigint → smallest-units string (NFR-2). */
function serializeSubscription(view: SubscriptionView): {
  id: string;
  roseNoteId: string;
  coupledPairId: string;
  subscriber: string;
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
    subscriber: view.subscriber,
    amount: view.amount.toString(),
    paymentAsset: view.paymentAsset,
    status: view.status,
    txHash: view.txHash,
    journalEntryId: view.journalEntryId,
  };
}

function requireService(deps: ApiDeps): NonNullable<ApiDeps['subscriptions']> {
  if (deps.subscriptions === undefined) {
    throw new ApiError(
      503,
      'SUBSCRIPTION_SERVICE_UNAVAILABLE',
      'The subscription service is not configured on this deployment (paper/live composition not wired).',
    );
  }
  return deps.subscriptions;
}

export function subscriptionRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/rose-notes/:id/subscriptions',
      {
        schema: {
          summary: 'Subscribe to a Rose Note (paired mint, paper/testnet)',
          tags: ['write'],
          params: IdParamSchema,
          body: SubscribeRequestSchema,
          response: {
            201: SubscriptionSchema,
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
        const view = await service.subscribe({
          roseNoteId: id,
          subscriber: body.subscriber,
          amount: BigInt(body.amount),
          paymentAsset: body.paymentAsset,
          idempotencyKey: body.idempotencyKey,
        });
        reply.status(201);
        return serializeSubscription(view);
      },
    );

    app.get(
      '/subscriptions/:id',
      {
        schema: {
          summary: 'Read a subscription status (pending until the on-chain commit point)',
          tags: ['read'],
          params: SubscriptionIdParamSchema,
          response: { 200: SubscriptionSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) => {
        const service = requireService(deps);
        const { id } = request.params;
        const view = await service.getSubscription(id);
        if (view === null) {
          throw new NotFoundError(`Subscription '${id}' not found.`, { id });
        }
        return serializeSubscription(view);
      },
    );
  };
}
