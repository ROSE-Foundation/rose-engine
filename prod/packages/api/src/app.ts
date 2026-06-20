// The typed REST boundary factory (Story 6.1, FR-14 foundation). `buildApp(deps)` returns a Fastify
// instance wired with the Zod type provider (`fastify-type-provider-zod`) so request/response
// schemas ARE Zod and `@fastify/swagger` derives the OpenAPI document from those SAME schemas
// (single source of the I/O types). Dependencies — the ledger `RoseDb` and the OPTIONAL injected
// `ChainSupplySnapshot` — are INJECTED; the app opens NO DB pool and NO network socket itself, so it
// is exercised entirely in-process via Fastify `inject` (LOCAL-testable, no port, no secret). This
// is the boundary the live write paths (Stories 6.2→6.6) branch onto.
import fastifySwagger from '@fastify/swagger';
import type { RoseDb } from '@rose/ledger';
import type { PriceOracle } from '@rose/price-oracle';
import type { PositionService } from '@rose/positions';
import type { ChainSupplySnapshot, CovenantThresholds } from '@rose/reconcile';
import type { RedemptionService, StrategyExecutor, SubscriptionService } from '@rose/rose-note';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { mapErrorToResponse } from './errors.js';
import { coupledPairRoutes } from './routes/coupled-pairs.js';
import { groupViewRoutes } from './routes/group-view.js';
import { healthRoutes } from './routes/health.js';
import { openApiRoutes } from './routes/openapi.js';
import { positionRoutes } from './routes/positions.js';
import { redemptionRoutes } from './routes/redemptions.js';
import { roseNoteRoutes } from './routes/rose-notes.js';
import { strategyRoutes } from './routes/strategy.js';
import { subscriptionRoutes } from './routes/subscriptions.js';

/** OpenAPI document metadata. */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/**
 * The parked oracle trust inputs the `/positions` mark-to-market is evaluated against (§15 oracle
 * integrity). REQUIRED whenever a `priceOracle` is composed — never silently defaulted by the API.
 * Loaded by the composition root and injected (the API/oracle layers read no env).
 */
export interface MarkTrustInputs {
  /** Max age (ms) before a quote is STALE. Non-negative. */
  readonly freshnessBoundMs: number;
  /** Max plausible |(P − P₀)/P₀| before a figure is flagged DIVERGENT. Positive decimal string. */
  readonly maxRelativeDivergence: string;
}

/** Injected dependencies for the boundary. The app NEVER opens these connections itself. */
export interface ApiDeps {
  /** The ledger database handle (read-only use in this story). */
  readonly db: RoseDb;
  /** Optional on-chain supply snapshot for the `/group-view` divergence signal (injected port). */
  readonly chainSupplies?: ChainSupplySnapshot;
  /**
   * Optional bright-line covenant thresholds for the `/group-view` covenant monitor. Loaded by the
   * composition root from `@rose/config` (`loadCovenantThresholds`, refuse-if-absent) and injected —
   * the API/reconcile layers never read env. When absent, the covenant monitor is empty.
   */
  readonly covenantThresholds?: CovenantThresholds;
  /**
   * Optional Rose Note subscription service (the `@rose/rose-note` composition layer, Story 6.2,
   * FR-11). Injected port — the API gains NO direct `@rose/chain`/`viem` edge; the chain edge lives
   * inside `@rose/rose-note`. When absent, the subscription write path is a typed 503 (refuse-if-absent).
   */
  readonly subscriptions?: SubscriptionService;
  /**
   * Optional Rose Note redemption service (the `@rose/rose-note` composition layer, Story 6.3,
   * FR-11). Injected port — the API gains NO direct `@rose/chain`/`viem` edge; the chain edge lives
   * inside `@rose/rose-note`. When absent, the redemption write path is a typed 503 (refuse-if-absent).
   */
  readonly redemptions?: RedemptionService;
  /**
   * Optional coupled-pair strategy executor (the `@rose/rose-note` paper/testnet execution layer,
   * Story 6.4, FR-20). Injected port (the NFR-7 seam — re-implementable in Rust/Go) — the API gains NO
   * direct `@rose/chain`/`viem` edge. When absent, the strategy write path is a typed 503 (refuse-if-absent).
   */
  readonly strategy?: StrategyExecutor;
  /**
   * Optional read-only `PriceOracle` (Story 8.1, FR-24) — supplies the reference-asset price for the
   * `/positions` mark-to-market (Story 8.4). Injected port (NFR-8); the oracle writes NO postings.
   * When absent, `/positions` marks are the honest NO_FEED state (never a fabricated price).
   */
  readonly priceOracle?: PriceOracle;
  /**
   * Optional oracle trust inputs (§15). REQUIRED when `priceOracle` is composed (else `/positions`
   * returns a typed 503 — never silently default a trust bound). Ignored when no oracle is composed.
   */
  readonly markTrust?: MarkTrustInputs;
  /**
   * Optional Epic-8 position service (the paper composition layer over `@rose/positions`
   * `makePositionService`, Stories 8.3/8.6). Injected port — the API gains its `@rose/chain` edge only
   * through this paper composition (`paper-position-service.ts`). Drives `POST /positions/open|close`
   * and the per-flow status reads. When absent (read-only / non-paper deployment), those write paths
   * are a typed 503 (refuse-if-absent); the `GET /positions` P&L read is unaffected. Also gates the
   * operator `POST /positions/reconcile` route (paper-only).
   */
  readonly positionService?: PositionService;
  /** Optional OpenAPI metadata override. */
  readonly openApiInfo?: OpenApiInfo;
  /** Optional Fastify logger toggle (defaults off — tests stay quiet). */
  readonly logger?: boolean;
}

/** Optional overrides for the boundary's error-handling install. */
export interface ErrorHandlingOptions {
  /**
   * Override the unmatched-route handler. The default returns a structured `ROUTE_NOT_FOUND` 404.
   * The shared live-environment server (`serve.ts`) supplies a SPA-fallback handler here so deep
   * links resolve to the front-end `index.html` instead of a JSON 404 — without changing the
   * default behavior the in-process API tests rely on.
   */
  readonly notFoundHandler?: (request: FastifyRequest, reply: FastifyReply) => void;
}

/**
 * Install the boundary's structured-error contract on a Fastify instance: Zod request-validation
 * failures ⇒ 400, every other thrown error ⇒ the single `mapErrorToResponse` translator (UX-DR5/
 * NFR-4 — refusals never collapsed), and an unmatched route ⇒ a structured 404 (or a caller-supplied
 * handler). Exported so the exact same handling can be exercised in isolation (tests) and reused by
 * future composition.
 */
export function installErrorHandling(app: FastifyInstance, opts?: ErrorHandlingOptions): void {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: error.validation,
        },
      });
      return;
    }
    const { status, body } = mapErrorToResponse(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error at the API boundary');
    }
    reply.status(status).send(body);
  });

  if (opts?.notFoundHandler) {
    app.setNotFoundHandler(opts.notFoundHandler);
    return;
  }

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found.`,
      },
    });
  });
}

const DEFAULT_OPENAPI_INFO: OpenApiInfo = Object.freeze({
  title: 'ROSE Engine API',
  version: '0.1.0',
  description:
    'Typed REST boundary for the ROSE Engine (FR-14). Read-only endpoints over the ledger/group view; ' +
    'money is serialized as decimal strings (NFR-2); refusals carry a specific code (UX-DR5).',
});

/**
 * Optional composition extensions for `buildApp`. Additive and runtime-inert when omitted, so the
 * in-process API tests (`buildApp({ db })`) are unaffected. The shared live-environment server
 * (`serve.ts`) uses these to wrap the SAME app in a single basic-auth gate and a static front-end —
 * rather than duplicating the swagger/error/route wiring.
 */
export interface BuildAppExtensions {
  /**
   * Invoked AFTER the error-handling contract is installed and BEFORE any route is registered, so a
   * global `onRequest` auth hook added here protects every subsequent route (API + openapi + static).
   */
  readonly beforeRoutes?: (app: FastifyInstance) => Promise<void> | void;
  /** Override the unmatched-route handler (e.g. a SPA fallback to `index.html`). */
  readonly notFoundHandler?: ErrorHandlingOptions['notFoundHandler'];
}

/**
 * Build the typed Fastify app. Async because `@fastify/swagger` registration and route registration
 * are awaited; callers/tests then use `app.inject(...)` (no socket is bound). Remember to `app.close()`.
 */
export async function buildApp(deps: ApiDeps, ext?: BuildAppExtensions): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();

  // Zod is the validator AND the serializer (request + response validated against the Zod schemas).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The OpenAPI document is derived from the Zod schemas via `jsonSchemaTransform`.
  const info = deps.openApiInfo ?? DEFAULT_OPENAPI_INFO;
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: info.title, version: info.version, description: info.description },
    },
    transform: jsonSchemaTransform,
  });

  // The structured-error contract (UX-DR5/NFR-4 — refusals never collapsed into a generic error).
  installErrorHandling(app, { notFoundHandler: ext?.notFoundHandler });

  // Composition hook: register the auth gate + static plugin (serve.ts) before any route, so the
  // global onRequest auth hook applies to every route registered below.
  if (ext?.beforeRoutes) {
    await ext.beforeRoutes(app);
  }

  // Routes — base READ-ONLY surface + system endpoints.
  await app.register(healthRoutes);
  await app.register(openApiRoutes);
  await app.register(groupViewRoutes(deps));
  await app.register(coupledPairRoutes(deps));
  await app.register(positionRoutes(deps));
  await app.register(roseNoteRoutes(deps));
  await app.register(subscriptionRoutes(deps));
  await app.register(redemptionRoutes(deps));
  await app.register(strategyRoutes(deps));

  await app.ready();
  return app;
}
