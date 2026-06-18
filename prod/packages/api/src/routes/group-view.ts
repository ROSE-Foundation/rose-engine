// GET /group-view — the consolidated group view (FR-9) as typed JSON (Story 6.1). A thin HTTP
// wrapper over `@rose/reconcile` `buildGroupView` → `groupViewToJson` (already a plain, no-`bigint`/
// no-float object; money as decimal strings). When a `ChainSupplySnapshot` is injected the view also
// carries the read-only ledger↔chain divergence signal (D3 — chain authoritative); the boundary
// opens NO chain connection itself (injected port).
import { buildGroupView, groupViewToJson } from '@rose/reconcile';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { GroupViewSchema, type GroupViewResponse } from '../schemas.js';

export function groupViewRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/group-view',
      {
        schema: {
          summary: 'Consolidated group view (per-entity balances, group NAV, pair positions)',
          tags: ['read'],
          response: { 200: GroupViewSchema },
        },
      },
      async () => {
        const view = await buildGroupView(deps.db, {
          chainSupplies: deps.chainSupplies,
          covenantThresholds: deps.covenantThresholds,
        });
        // `GroupView` uses `readonly` arrays; the response shape is structurally identical (a
        // compile-time-only variance) — cast to the inferred wire type. Runtime object is unchanged.
        return groupViewToJson(view) as GroupViewResponse;
      },
    );
  };
}
