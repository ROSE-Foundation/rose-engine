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
import { listPositionsByOwner } from '@rose/positions';
import { markToMarket, type MarkablePair } from '@rose/price-oracle';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError } from '../errors.js';
import { ErrorResponseSchema, PositionsQuerySchema, PositionsResponseSchema } from '../schemas.js';
import { noFeedMarkResponse, serializeMark, serializePosition } from '../serializers.js';
import type { PositionMarkResponse } from '../serializers.js';

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
        const { owner, referenceAsset } = request.query;
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
  };
}
