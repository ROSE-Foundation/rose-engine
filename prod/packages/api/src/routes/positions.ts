// GET /positions — per-user positions + live P&L (Story 8.4, FR-26). Lists one owner's positions
// (8.2/8.3) and marks each one with the 8.1 `markToMarket` over its linked coupled pair. The
// `PriceOracle` and the parked trust inputs (`freshnessBoundMs`/`maxRelativeDivergence`, §15) are
// INJECTED ports on `ApiDeps` — the route reads no env and the oracle writes no postings (read-only).
//
// Money crosses as STRINGS (NFR-2): genuinely-decimal fields (entry P₀, mark price, floor, distance)
// as decimal strings; smallest-unit magnitudes (size/collateral/realized + the directional unrealized
// P&L) as raw smallest-unit integer strings (the 6.1 no-fabricated-scale precedent). A mark is NEVER
// fabricated: no oracle ⇒ the explicit NO_FEED state; an absent/stale/divergent feed ⇒ the explicit
// 8.1 state with null trusted fields. Fail-closed: an oracle configured WITHOUT a trust input ⇒ a
// typed 503 (never silently default a trust bound).
import { getCoupledPair } from '@rose/ledger';
import {
  buildInjectedDivergencePlan,
  listPositionsByOwner,
  reconcilePositionsToPairs,
  type PositionService,
} from '@rose/positions';
import { markToMarket, type MarkablePair } from '@rose/price-oracle';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAddress } from 'viem';
import type { ApiDeps } from '../app.js';
import { ApiError, NotFoundError } from '../errors.js';

/**
 * Canonicalize an owner to the EIP-55 checksum form so reads match what the open path stores (positions
 * persist the checksummed owner). Without this, a lowercase query — exactly what the SPA sends from its
 * baked-in `VITE_SUBSCRIBER_ADDRESS` — would never match a stored mixed-case owner and the listing would
 * be silently empty. Lenient by design: a value that is not a parseable EVM address is returned
 * unchanged (it simply matches nothing, as before — no behavioural/contract change for non-address keys).
 */
function canonicalOwner(owner: string): string {
  try {
    return getAddress(owner);
  } catch {
    return owner;
  }
}
import {
  ClosePositionRequestSchema,
  ClosePositionViewSchema,
  ErrorResponseSchema,
  OpenPositionRequestSchema,
  OpenPositionViewSchema,
  PositionFlowIdParamSchema,
  PositionReconciliationReportSchema,
  PositionsQuerySchema,
  PositionsResponseSchema,
} from '../schemas.js';
import {
  noFeedMarkResponse,
  serializeClosePositionView,
  serializeMark,
  serializeOpenPositionView,
  serializePosition,
  serializePositionReconciliationReport,
} from '../serializers.js';
import type { PositionMarkResponse } from '../serializers.js';

/**
 * Resolve the Epic-8 position service, or refuse with a typed 503 (refuse-if-absent). The open/close
 * write paths and the operator reconcile route are composed ONLY in paper mode (`ENGINE_MODE=paper`);
 * a read-only / non-paper deployment never exposes them — the `GET /positions` P&L read is unaffected.
 */
function requirePositionService(deps: ApiDeps): PositionService {
  if (deps.positionService === undefined) {
    throw new ApiError(
      503,
      'POSITION_SERVICE_UNAVAILABLE',
      'The position open/close service is not configured on this deployment (paper composition not ' +
        'wired). Set ENGINE_MODE=paper for the fully interactive simulated environment.',
    );
  }
  return deps.positionService;
}

export function positionRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/positions',
      {
        schema: {
          summary: 'List a user’s positions with live marks + P&L',
          tags: ['read'],
          querystring: PositionsQuerySchema,
          response: {
            200: PositionsResponseSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const { referenceAsset } = request.query;
        const owner = canonicalOwner(request.query.owner);
        const oracle = deps.priceOracle;
        const trust = deps.markTrust;

        // Fail-closed: an oracle is composed but no trust input was injected — never silently default
        // a freshness/divergence bound that would trust a stale or implausible figure (§15).
        if (oracle !== undefined && trust === undefined) {
          throw new ApiError(
            503,
            'POSITION_MARK_TRUST_UNAVAILABLE',
            'The price-oracle is configured but its trust inputs (freshness/divergence bounds) are not. ' +
              'Marks are refused rather than silently trusted (§15 oracle integrity).',
          );
        }

        const views = await listPositionsByOwner(deps.db, {
          owner,
          ...(referenceAsset !== undefined ? { referenceAsset } : {}),
        });

        const positions = [];
        for (const view of views) {
          const pair = await getCoupledPair(deps.db, view.coupledPairId);
          // A position always references an issued pair (NOT NULL FK). If the pair read is somehow
          // null it is an integrity anomaly — surface an explicit no-feed mark (never fabricate one).
          let mark: PositionMarkResponse;
          if (oracle === undefined || pair === null) {
            mark = noFeedMarkResponse(view.entryPrice, pair?.floor ?? '0');
          } else {
            const markable: MarkablePair = {
              referenceAsset: pair.referenceAsset,
              anchorPrice: pair.anchorPrice,
              leverage: pair.leverage,
              collateralPool: pair.collateralPool,
              floor: pair.floor,
            };
            const quote = await oracle.getPrice(view.referenceAsset);
            // `trust` is defined here (the fail-closed guard above rejects oracle-without-trust).
            const computed = markToMarket(markable, quote, {
              freshnessBoundMs: trust!.freshnessBoundMs,
              maxRelativeDivergence: trust!.maxRelativeDivergence,
            });
            mark = serializeMark(computed, view.side);
          }
          positions.push(serializePosition(view, mark));
        }

        return { owner, positions };
      },
    );

    // ─── Open a directional position (Story 8.3, FR-25) — paired mint over subscribe/mint ─────────
    app.post(
      '/positions/open',
      {
        schema: {
          summary: 'Open a directional position (paired mint, paper)',
          tags: ['write'],
          body: OpenPositionRequestSchema,
          response: {
            200: OpenPositionViewSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            422: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const service = requirePositionService(deps);
        const body = request.body;
        const view = await service.openPosition({
          coupledPairId: body.coupledPairId,
          owner: body.owner,
          side: body.side,
          amount: BigInt(body.amount),
          paymentAsset: body.paymentAsset,
          idempotencyKey: body.idempotencyKey,
        });
        return serializeOpenPositionView(view);
      },
    );

    // ─── Close a position (Stories 8.3/8.6, FR-25) — paired burn over redeem/burn ─────────────────
    // The §11.4 solvency guardrail (D1 single-side topology — the opposite leg held by another user)
    // surfaces a 409 `SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` via the boundary error registry,
    // BEFORE any burn is submitted (the headline Epic-8.6 live test).
    app.post(
      '/positions/close',
      {
        schema: {
          summary: 'Close a position (paired burn, paper); §11.4 single-side close refused (409)',
          tags: ['write'],
          body: ClosePositionRequestSchema,
          response: {
            200: ClosePositionViewSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            422: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const service = requirePositionService(deps);
        const body = request.body;
        const view = await service.closePosition({
          positionId: body.positionId,
          paymentAsset: body.paymentAsset,
          idempotencyKey: body.idempotencyKey,
        });
        return serializeClosePositionView(view);
      },
    );

    // ─── Read an open-flow status (pending until the on-chain commit point) ───────────────────────
    app.get(
      '/positions/open/:id',
      {
        schema: {
          summary: 'Read a position-open flow status (pending until the on-chain commit point)',
          tags: ['read'],
          params: PositionFlowIdParamSchema,
          response: {
            200: OpenPositionViewSchema,
            404: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const service = requirePositionService(deps);
        const { id } = request.params;
        const view = await service.getOpenPosition(id);
        if (view === null) {
          throw new NotFoundError(`Position-open flow '${id}' not found.`, { id });
        }
        return serializeOpenPositionView(view);
      },
    );

    // ─── Read a close-flow status (pending until the on-chain commit point) ───────────────────────
    app.get(
      '/positions/close/:id',
      {
        schema: {
          summary: 'Read a position-close flow status (pending until the on-chain commit point)',
          tags: ['read'],
          params: PositionFlowIdParamSchema,
          response: {
            200: ClosePositionViewSchema,
            404: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const service = requirePositionService(deps);
        const { id } = request.params;
        const view = await service.getClosePosition(id);
        if (view === null) {
          throw new NotFoundError(`Position-close flow '${id}' not found.`, { id });
        }
        return serializeClosePositionView(view);
      },
    );

    // ─── Operator: position ↔ pair reconciliation (Story 8.5, FR-27) ──────────────────────────────
    // A per-(pair, side) residual-backing + mismatch report. Normally called with NO chain-closed facts
    // (report-only, posts NO correcting entries). When the faithful operator reconcile-divergence
    // injection is ARMED (Story 9.5, FR-32), a plan is built from the live DB so THIS run reports-and-
    // corrects a genuine divergence through the SAME path (journaled, surfaced — NFR-3). Gated on the
    // position service being composed (paper/faithful only).
    app.post(
      '/positions/reconcile',
      {
        schema: {
          summary: 'Operator position↔pair reconciliation report (report-and-correct)',
          tags: ['read'],
          response: { 200: PositionReconciliationReportSchema, 503: ErrorResponseSchema },
        },
      },
      async () => {
        requirePositionService(deps);
        const injected = deps.reconcileInjection?.get().active
          ? await buildInjectedDivergencePlan(deps.db)
          : null;
        const report = await reconcilePositionsToPairs(deps.db, injected ?? {});
        return serializePositionReconciliationReport(report);
      },
    );
  };
}
