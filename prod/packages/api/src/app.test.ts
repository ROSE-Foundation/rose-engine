// Story 6.1 — the typed REST boundary proven IN-PROCESS via Fastify `inject` against the LOCAL
// Postgres (NO Sepolia, NO network port, NO key). Mirrors the `@rose/reconcile` DB harness
// (createPool/createDb/hardReset/migrateUp, TRUNCATE … CASCADE). Asserts: Zod-validated I/O, money
// as decimal strings (NFR-2), the OpenAPI document is derived from the schemas, and the structured
// error contract (400/403/404/409/422) surfaces with specific codes (UX-DR5).
import {
  createCoupledPair,
  createDb,
  createPool,
  createRoseNote,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { ChainSupplySnapshot } from '@rose/reconcile';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, installErrorHandling } from './app.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool();
  await hardReset(pool);
  await migrateUp(pool);
  db = createDb(pool);
  app = await buildApp({ db });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE rose_notes, coupled_pairs, postings, journal_entries CASCADE');
});

async function seedPair(longShort = 500_000_000n): Promise<string> {
  const pair = await createCoupledPair(db, {
    referenceAsset: 'EUR/USD',
    anchorPrice: '1.10000000',
    leverage: '3',
    collateralPool: 1_000_000_000n,
    floor: '0.50',
    longLegValue: longShort,
    shortLegValue: longShort,
  });
  return pair.id;
}

describe('GET /health', () => {
  it('returns 200 { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /group-view', () => {
  it('returns 200 with the consolidated shape; money is decimal strings; JSON has no bigint', () => {
    return app.inject({ method: 'GET', url: '/group-view' }).then((res) => {
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('entities');
      expect(body).toHaveProperty('consolidated');
      expect(body).toHaveProperty('coupledPairs');
      expect(body.chainComparison.source).toBe('ledger-only');
      // The four fixed entities are always rendered.
      expect(body.entities.map((e: { entityCode: string }) => e.entityCode).sort()).toEqual([
        'COIN_ISSUER',
        'HOLDING',
        'TRADING_CO',
        'VCC',
      ]);
      // The raw payload string carries no bigint literal artifact and round-trips.
      expect(() => JSON.parse(res.payload)).not.toThrow();
    });
  });

  it('surfaces a seeded coupled-pair position with magnitudes as integer strings', async () => {
    await seedPair();
    const res = await app.inject({ method: 'GET', url: '/group-view' });
    const body = res.json();
    expect(body.coupledPairs).toHaveLength(1);
    const pos = body.coupledPairs[0];
    expect(pos.longLegValue).toBe('500000000');
    expect(pos.collateralPool).toBe('1000000000');
    expect(typeof pos.anchorPrice).toBe('string');
  });
});

describe('GET /coupled-pairs/:id', () => {
  it('returns 200 with the pair (smallest-units as integer strings) for a seeded id', async () => {
    const id = await seedPair();
    const res = await app.inject({ method: 'GET', url: `/coupled-pairs/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.collateralPool).toBe('1000000000');
    expect(body.longLegValue).toBe('500000000');
    expect(body.anchorPrice).toBe('1.10000000');
    expect(body.state).toBe('PENDING');
    expect(typeof body.createdAt).toBe('string');
    // No JS number money value anywhere.
    expect(typeof body.collateralPool).toBe('string');
  });

  it('returns a structured 404 for a well-formed but absent id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/coupled-pairs/99999999-9999-4999-8999-999999999999',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.json().error.message).toContain('not found');
  });

  it('returns a structured 400 for a malformed (non-UUID) id (Zod validation)', async () => {
    const res = await app.inject({ method: 'GET', url: '/coupled-pairs/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /rose-notes/:id', () => {
  it('returns 200 for a seeded note and 404 for an absent one', async () => {
    const pairId = await seedPair();
    const note = await createRoseNote(db, { coupledPairId: pairId });
    const ok = await app.inject({ method: 'GET', url: `/rose-notes/${note.id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: note.id, coupledPairId: pairId });

    const missing = await app.inject({
      method: 'GET',
      url: '/rose-notes/99999999-9999-4999-8999-999999999999',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });
});

describe('GET /openapi.json (OpenAPI derived from the Zod schemas)', () => {
  it('lists the registered paths and the component schemas', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/health', '/group-view', '/coupled-pairs/{id}', '/rose-notes/{id}']),
    );
    // The coupled-pair response money fields are typed as strings in the derived schema.
    const okSchema =
      doc.paths['/coupled-pairs/{id}'].get.responses['200'].content['application/json'].schema;
    const props = okSchema.properties ?? {};
    expect(props.collateralPool.type).toBe('string');
    expect(props.longLegValue.type).toBe('string');
  });
});

describe('NFR-2 — money precision survives the FULL HTTP serialize path', () => {
  it('serves a magnitude beyond Number.MAX_SAFE_INTEGER as an exact integer string (no float loss)', async () => {
    // 2^53 + 1 = 9007199254740993 is unrepresentable as a JS number; must stay an exact string.
    const huge = 9_007_199_254_740_993n;
    const pair = await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.10000000',
      leverage: '3',
      collateralPool: huge,
      floor: '0.50',
      longLegValue: huge,
      shortLegValue: huge,
    });
    const res = await app.inject({ method: 'GET', url: `/coupled-pairs/${pair.id}` });
    expect(res.statusCode).toBe(200);
    // Assert against the RAW payload string — JSON.parse would already have lost precision if the
    // server had emitted a number rather than a string.
    expect(res.payload).toContain('"collateralPool":"9007199254740993"');
    expect(res.json().longLegValue).toBe('9007199254740993');
  });
});

describe('GET /group-view — injected ChainSupplySnapshot seam (the 6.2→6.6 / 5.6 port)', () => {
  it('labels source "ledger+chain" and reports the divergence signal when a snapshot is injected', async () => {
    const snapshot: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [{ asset: 'ROSE_L', scale: 18, totalSupply: 1_000n }],
    };
    const chainApp = await buildApp({ db, chainSupplies: snapshot });
    try {
      const res = await chainApp.inject({ method: 'GET', url: '/group-view' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe('ledger+chain');
      expect(body.chainComparison.source).toBe('ledger+chain');
      expect(body.chainComparison.divergences).toHaveLength(1);
      // No ledger ROSE_L account ⇒ ledger quantity 0 ⇒ the chain supply is reported as divergence.
      const d = body.chainComparison.divergences[0];
      expect(d.asset).toBe('ROSE_L');
      expect(d.onChainTotalSupply.smallestUnits).toBe('1000');
      expect(typeof d.divergence.smallestUnits).toBe('string');
    } finally {
      await chainApp.close();
    }
  });
});

describe('an unmatched route returns a structured 404', () => {
  it('uses ROUTE_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
});

// The error handler wired by `installErrorHandling` proven END-TO-END through Fastify: a route that
// throws a domain/authorization error yields the correct status + specific code (UX-DR5). Uses a
// bare app with the SAME error handling — no test-only route lives in the prod app.
describe('installErrorHandling — domain/authorization errors over HTTP', () => {
  function throwingApp(error: unknown): FastifyInstance {
    const t = Fastify().withTypeProvider<ZodTypeProvider>();
    t.setValidatorCompiler(validatorCompiler);
    t.setSerializerCompiler(serializerCompiler);
    installErrorHandling(t);
    t.get('/boom', async () => {
      throw error;
    });
    return t;
  }

  it('TransferRefusedError(DENY) → 403 AUTHORIZATION_DENIED', async () => {
    const err = Object.assign(new Error('Transfer DENY: default-deny'), {
      name: 'TransferRefusedError',
      effect: 'DENY',
      reason: 'default-deny',
    });
    const t = throwingApp(err);
    const res = await t.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_DENIED');
    await t.close();
  });

  it('TransferRefusedError(REFUSE) → 422 AUTHORIZATION_REFUSED', async () => {
    const err = Object.assign(new Error('Transfer REFUSE: eligibility'), {
      name: 'TransferRefusedError',
      effect: 'REFUSE',
      reason: 'eligibility',
    });
    const t = throwingApp(err);
    const res = await t.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AUTHORIZATION_REFUSED');
    await t.close();
  });

  it('UnbalancedEntryError → 409', async () => {
    const err = new Error('postings do not balance');
    err.name = 'UnbalancedEntryError';
    const t = throwingApp(err);
    const res = await t.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UnbalancedEntryError');
    await t.close();
  });

  it('an unknown error → generic 500 with no leak', async () => {
    const t = throwingApp(new Error('SECRET stack detail'));
    const res = await t.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.payload).not.toContain('SECRET');
    await t.close();
  });
});
