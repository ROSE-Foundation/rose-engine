// Coupled-pair strategy execution endpoints (Story 6.4, FR-20) — the paper/testnet threshold-only
// reset flow branching onto the 6.1 typed boundary. `POST /coupled-pairs/:id/strategy/ticks` feeds a
// price tick to the injected `StrategyExecutor` (the `@rose/rose-note` execution layer); a within-
// barrier tick is a strict no-op, a floor breach starts a reset (pending until the on-chain commit
// point). `GET /strategy/resets/:id` reads the pending/confirmed reset status. The route holds no
// chain/ledger/strategy logic — it validates I/O (Zod), maps money/marks to/from smallest-units
// STRINGS (NFR-2), and lets domain/authorization refusals surface through the 6.1 structured-error
// translator (authorization DENY ⇒ 403 / REFUSE ⇒ 422, idempotency/state ⇒ 409, invalid ⇒ 422,
// not-found ⇒ 404, config refusal ⇒ 503, validation ⇒ 400). When the executor is not composed the
// write path is a typed 503 (refuse-if-absent).
import type { StrategyResetView, StrategyTickOutcome } from '@rose/rose-note';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError, NotFoundError } from '../errors.js';
import {
  ErrorResponseSchema,
  IdParamSchema,
  StrategyResetIdParamSchema,
  StrategyResetSchema,
  StrategyTickOutcomeSchema,
  StrategyTickRequestSchema,
} from '../schemas.js';

/** Serialize a `StrategyTickOutcome` for the wire: `floorUnits` bigint → smallest-units string (NFR-2). */
function serializeOutcome(o: StrategyTickOutcome): {
  pairId: string;
  action: 'none' | 'reset-started';
  reason: string;
  losingLeg: 'long' | 'short' | null;
  floorUnits: string;
  state: 'PENDING' | 'ACTIVE' | 'REBALANCING' | 'PARTIAL' | 'SETTLING' | 'CLOSED';
  txHash: string | null;
  resetId: string | null;
} {
  return {
    pairId: o.pairId,
    action: o.action,
    reason: o.reason,
    losingLeg: o.losingLeg,
    floorUnits: o.floorUnits.toString(),
    state: o.state,
    txHash: o.txHash,
    resetId: o.resetId,
  };
}

/** Serialize a `StrategyResetView` for the wire (all fields already strings/nullable). */
function serializeReset(view: StrategyResetView): {
  id: string;
  pairId: string;
  status: 'pending' | 'confirmed' | 'failed';
  txHash: string | null;
  journalEntryId: string | null;
} {
  return {
    id: view.id,
    pairId: view.pairId,
    status: view.status,
    txHash: view.txHash,
    journalEntryId: view.journalEntryId,
  };
}

function requireService(deps: ApiDeps): NonNullable<ApiDeps['strategy']> {
  if (deps.strategy === undefined) {
    throw new ApiError(
      503,
      'STRATEGY_SERVICE_UNAVAILABLE',
      'The strategy executor is not configured on this deployment (paper/live composition not wired).',
    );
  }
  return deps.strategy;
}

export function strategyRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/coupled-pairs/:id/strategy/ticks',
      {
        schema: {
          summary:
            'Feed a price tick to the strategy executor (threshold-only reset, paper/testnet)',
          tags: ['write'],
          params: IdParamSchema,
          body: StrategyTickRequestSchema,
          response: {
            200: StrategyTickOutcomeSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            422: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const service = requireService(deps);
        const { id } = request.params;
        const body = request.body;
        const outcome = await service.onTick({
          pairId: id,
          price: body.price,
          longLegMarkValue: BigInt(body.longLegMarkValue),
          shortLegMarkValue: BigInt(body.shortLegMarkValue),
          paymentAsset: body.paymentAsset,
          resetIdempotencyKey: body.resetIdempotencyKey,
        });
        return serializeOutcome(outcome);
      },
    );

    app.get(
      '/strategy/resets/:id',
      {
        schema: {
          summary: 'Read a strategy reset status (pending until the on-chain commit point)',
          tags: ['read'],
          params: StrategyResetIdParamSchema,
          response: { 200: StrategyResetSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) => {
        const service = requireService(deps);
        const { id } = request.params;
        const view = await service.getReset(id);
        if (view === null) {
          throw new NotFoundError(`Strategy reset '${id}' not found.`, { id });
        }
        return serializeReset(view);
      },
    );
  };
}
