// Shared live-environment server (infrastructure, NOT a BMAD story). Wraps the SAME typed Fastify
// boundary (`buildApp`) in ONE basic-auth gate and serves the `@rose/web` static build on the SAME
// origin (no CORS) — a single managed-PaaS web service for participants to exercise the screens.
//
// Design constraints honored here:
//  - refuse-if-absent: the server REFUSES to start unless BOTH BASIC_AUTH_USER and
//    BASIC_AUTH_PASSWORD are present (a live environment is NEVER exposed without protection),
//    and unless DATABASE_URL is present (no silent local-default in a deployed environment).
//  - the gate protects EVERY route: API, /openapi.json, and the static front-end + SPA fallback.
//  - regime boundary: the front-end is served by FILESYSTEM PATH at runtime (WEB_DIST_DIR); there
//    is no `import ... from '@rose/web'` (that would be a source dependency, not what this is).
//  - NO secret is hard-coded; credentials and DATABASE_URL come from the environment only.
//
// The chain-dependent WRITE services (subscriptions/redemptions/strategy) are composed ONLY when
// PAPER MODE is EXPLICITLY requested via `ENGINE_MODE=paper` — an in-process, network-free, secret-free
// simulation (the `@rose/rose-note` paper composition over the `@rose/chain` paper transport) that
// auto-confirms each write so participants can complete the flows end-to-end. Paper mode is NEVER
// enabled implicitly, and its on-chain effects are SIMULATED, not real (logged at boot). Without it the
// write routes return the existing typed 503 (refuse-if-absent); the real on-chain write path needs
// out-of-band Sepolia secrets and stays deferred. The READ surfaces always render fully.
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyStatic from '@fastify/static';
import {
  COVENANT_THRESHOLD_KEYS,
  loadCovenantThresholds,
  type CovenantThresholds,
} from '@rose/config';
import { createDb, createPool, migrateUp, type RoseDb } from '@rose/ledger';
import { makePaperModeServices, PAPER_MODE_BANNER } from '@rose/rose-note';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildApp, type ApiDeps, type MarkTrustInputs } from './app.js';
import { makePaperPositionService } from './paper-position-service.js';
import { makePaperReplayOracle } from './paper-replay-oracle.js';
import { seedPaperDemo } from './seed-demo.js';

/** Explicit paper-mode oracle trust inputs (§15) — a generous freshness bound + a 50% divergence band. */
const PAPER_MARK_TRUST: MarkTrustInputs = {
  freshnessBoundMs: 24 * 60 * 60 * 1000,
  maxRelativeDivergence: '0.5',
};

/** Validated shared basic-auth credentials. */
export interface BasicAuthCredentials {
  readonly user: string;
  readonly password: string;
}

/** Thrown at boot when a required environment variable is absent — fail-closed (NFR-4). */
export class ServerConfigRefusalError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `Refusing to start the shared live environment: missing required environment variable(s): ` +
        `${missing.join(', ')}. The basic-auth gate is mandatory (a live environment is never ` +
        `exposed without protection) and DATABASE_URL is never defaulted in a deployment.`,
    );
    this.name = 'ServerConfigRefusalError';
    this.missing = missing;
  }
}

/** Reads a required, non-empty environment variable, collecting absences for one clear refusal. */
function readRequired(
  env: Record<string, string | undefined>,
  key: string,
  missing: string[],
): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    missing.push(key);
    return '';
  }
  return value;
}

/**
 * Loads the shared basic-auth credentials, refusing (throwing `ServerConfigRefusalError`) if EITHER
 * `BASIC_AUTH_USER` or `BASIC_AUTH_PASSWORD` is absent/empty. The server never starts unprotected.
 */
export function loadBasicAuthCredentials(
  env: Record<string, string | undefined> = process.env,
): BasicAuthCredentials {
  const missing: string[] = [];
  const user = readRequired(env, 'BASIC_AUTH_USER', missing);
  const password = readRequired(env, 'BASIC_AUTH_PASSWORD', missing);
  if (missing.length > 0) {
    throw new ServerConfigRefusalError(missing);
  }
  return { user, password };
}

/**
 * Whether PAPER MODE is EXPLICITLY requested via `ENGINE_MODE=paper`. Paper mode is NEVER enabled
 * implicitly — it must be asked for by the environment (the on-chain effects it produces are SIMULATED,
 * not real). Any other value (incl. unset) leaves the write services uncomposed (the typed 503).
 */
export function isPaperModeRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.ENGINE_MODE ?? '').trim().toLowerCase() === 'paper';
}

/**
 * Loads the covenant thresholds for the dashboard's covenant monitor — an OPT-IN feature. When NONE
 * of the `COVENANT_*` keys are set, returns `undefined` (the monitor is simply empty, the read-only
 * deployable is unaffected). When ANY is set, `loadCovenantThresholds` enforces refuse-if-absent on
 * ALL three (NFR-4) — a partial/invalid configuration refuses, naming the offenders.
 */
export function loadOptionalCovenantThresholds(
  env: Record<string, string | undefined> = process.env,
): CovenantThresholds | undefined {
  const anyPresent = COVENANT_THRESHOLD_KEYS.some((key) => (env[key] ?? '').trim().length > 0);
  return anyPresent ? loadCovenantThresholds(env) : undefined;
}

/** Reads `DATABASE_URL`, refusing if absent — a deployed environment never uses a local default. */
export function requireDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const missing: string[] = [];
  const url = readRequired(env, 'DATABASE_URL', missing);
  if (missing.length > 0) {
    throw new ServerConfigRefusalError(missing);
  }
  return url;
}

/**
 * Constant-time string comparison. Both inputs are hashed to a fixed-length digest first, so the
 * comparison neither leaks length via an early return nor throws on length mismatch.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Default web build directory: `prod/packages/web/dist`, resolved relative to this compiled file. */
export function defaultWebDistDir(): string {
  return fileURLToPath(new URL('../../web/dist/', import.meta.url));
}

/** Options for `buildServer` — fully injectable so the auth gate is testable with NO real DB. */
export interface ServerOptions {
  /** Composed API dependencies (the ledger `RoseDb` + optional injected ports). */
  readonly deps: ApiDeps;
  /** Validated shared basic-auth credentials. */
  readonly credentials: BasicAuthCredentials;
  /** Filesystem path to the `@rose/web` static build (served on the same origin). */
  readonly webDistDir: string;
  /** Optional Fastify logger toggle. */
  readonly logger?: boolean;
}

/**
 * Builds the single shared-environment Fastify instance: the typed API boundary, the static
 * front-end, and a SPA fallback — ALL behind ONE basic-auth gate. Returns the (ready) instance;
 * the caller `listen`s on it. Exercisable in-process via `app.inject(...)` (no socket bound).
 */
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { credentials, webDistDir } = opts;

  const validate = (
    username: string,
    password: string,
    _req: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void => {
    const ok =
      constantTimeEqual(username, credentials.user) &&
      constantTimeEqual(password, credentials.password);
    done(ok ? undefined : new Error('Unauthorized'));
  };

  // SPA fallback: an unmatched GET resolves to the front-end shell so client-side deep links work.
  // This handler runs behind the same onRequest auth gate (added in `beforeRoutes`), so the fallback
  // is protected too. Non-GET unmatched requests get a structured 404.
  const notFoundHandler = (request: FastifyRequest, reply: FastifyReply): void => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      void reply.sendFile('index.html');
      return;
    }
    void reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found.`,
      },
    });
  };

  return buildApp(opts.deps, {
    notFoundHandler,
    beforeRoutes: async (app) => {
      await app.register(fastifyBasicAuth, { validate, authenticate: { realm: 'ROSE Engine' } });
      await app.register(fastifyStatic, { root: webDistDir, wildcard: false });
      // ONE global gate over EVERY route registered after this point + the static plugin + the SPA
      // fallback. `app.basicAuth` (decorated by the plugin above) validates the header; on failure we
      // send a clean 401 directly so the rejection is NOT collapsed into a generic 500 by the
      // boundary's domain-error handler (which intentionally does not key on transport auth errors).
      app.addHook('onRequest', (request, reply, done) => {
        app.basicAuth(request, reply, (err?: Error | null) => {
          if (err) {
            void reply
              .header('WWW-Authenticate', 'Basic realm="ROSE Engine"')
              .code(401)
              .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
            return;
          }
          done();
        });
      });
    },
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
}

/**
 * Entrypoint for the deployed web service. Refuses to start unless the basic-auth credentials AND
 * DATABASE_URL are present, applies pending migrations, composes the read-surface `ApiDeps`, and
 * binds the socket. Logs are intentionally explicit so a PaaS deploy is easy to follow.
 */
async function main(): Promise<void> {
  // refuse-if-absent: validate ALL required environment BEFORE opening any connection.
  const credentials = loadBasicAuthCredentials();
  const databaseUrl = requireDatabaseUrl();
  const covenantThresholds = loadOptionalCovenantThresholds();
  const webDistDir = process.env.WEB_DIST_DIR ?? defaultWebDistDir();
  const port = Number(process.env.PORT ?? 8080);

  console.log('[serve] starting ROSE Engine shared live environment…');
  const pool = createPool(databaseUrl);

  console.log('[serve] applying database migrations…');
  const applied = await migrateUp(pool);
  console.log(`[serve] migrations up to date (${applied.length} newly applied).`);

  const db: RoseDb = createDb(pool);
  // Read surfaces are always composed. The chain-dependent WRITE ports are composed ONLY when paper
  // mode is EXPLICITLY requested (ENGINE_MODE=paper) — never implicitly. Otherwise they stay absent
  // and their routes return the existing typed 503 (refuse-if-absent); the real on-chain write path
  // requires out-of-band Sepolia secrets and is intentionally deferred (not wired here).
  let deps: ApiDeps = { db, logger: true, covenantThresholds };
  if (isPaperModeRequested()) {
    console.warn(`[serve] ${PAPER_MODE_BANNER}`);
    console.log('[serve] paper mode: seeding demo data + composing simulated write services…');
    const paperConfig = await seedPaperDemo(db);
    const paper = makePaperModeServices({ db, ...paperConfig });
    // The Epic-8 position layer (open/close + the §11.4 guardrail) over the SAME paper transport. It
    // is composed here (in @rose/api) — NOT in @rose/rose-note — because @rose/positions already
    // depends on @rose/rose-note + @rose/chain (composing it there would be an import cycle).
    const positionService = makePaperPositionService({ db, paperConfig });
    deps = {
      db,
      logger: true,
      covenantThresholds,
      subscriptions: paper.subscriptions,
      redemptions: paper.redemptions,
      strategy: paper.strategy,
      positionService,
      // The position P&L endpoint shows LIVE, MOVING marks in paper mode: a deterministic replay feed
      // (Story-8.1 CsvReplayPriceOracle) oscillates each pair's price around its anchor within the §15
      // trust band, so directional P&L visibly moves (L gains / S mirrors) instead of sitting flat.
      priceOracle: makePaperReplayOracle(db),
      markTrust: PAPER_MARK_TRUST,
    };
    console.log(
      '[serve] paper mode ACTIVE — subscribe/redeem/strategy + position open/close are fully ' +
        'interactive; on-chain effects are SIMULATED in-process (no Sepolia, no secret).',
    );
  } else {
    console.log(
      '[serve] write services NOT composed (read-only). Set ENGINE_MODE=paper for a fully ' +
        'interactive SIMULATED environment; real on-chain writes need out-of-band Sepolia secrets (deferred).',
    );
  }

  const app = await buildServer({ deps, credentials, webDistDir, logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[serve] received ${signal}, shutting down…`);
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[serve] listening on http://0.0.0.0:${port} (basic-auth gate active).`);
  console.log(`[serve] serving web build from ${webDistDir}`);
}

// Run only when executed directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[serve] fatal:', err);
    process.exit(1);
  });
}
