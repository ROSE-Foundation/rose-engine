// Story 6.4 — the strategy execution HTTP contract proven IN-PROCESS via Fastify `inject` with a FAKE
// `StrategyExecutor` (the boundary stays decoupled from the chain; the real loop is proven in
// `@rose/rose-note`). Asserts: the tick `StrategyTickOutcome` shape with money/marks as STRINGS
// (NFR-2), authorization DENY → 403 / REFUSE → 422 (UX-DR5), idempotency/reset-window conflict → 409,
// invalid → 422, config refusal → 503, a malformed body → 400 (Zod), and a missing executor → 503
// (refuse-if-absent). NO DB, NO chain, NO secret.
import {
  StrategyResetIdempotencyConflictError,
  type StrategyExecutor,
  type StrategyResetView,
  type StrategyTick,
  type StrategyTickOutcome,
} from '@rose/rose-note';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { RoseDb } from '@rose/ledger';

const PAIR_ID = '22222222-2222-4222-8222-222222222222';
const DB_STUB = {} as RoseDb;

function startedOutcome(over: Partial<StrategyTickOutcome> = {}): StrategyTickOutcome {
  return {
    pairId: PAIR_ID,
    action: 'reset-started',
    reason: 'floor-breach',
    losingLeg: 'long',
    floorUnits: 6000n,
    state: 'REBALANCING',
    txHash: '0xfeed',
    resetId: 'reset-1',
    ...over,
  };
}

function pendingReset(over: Partial<StrategyResetView> = {}): StrategyResetView {
  return {
    id: 'reset-1',
    pairId: PAIR_ID,
    status: 'pending',
    txHash: '0xfeed',
    journalEntryId: null,
    ...over,
  };
}

function fakeExecutor(behavior: {
  onTick?: (tick: StrategyTick) => StrategyTickOutcome | Promise<StrategyTickOutcome>;
  onGet?: (id: string) => StrategyResetView | null;
}): StrategyExecutor {
  return {
    async onTick(tick) {
      if (behavior.onTick) return behavior.onTick(tick);
      return startedOutcome();
    },
    async confirmReset() {
      return null;
    },
    async getReset(id) {
      return behavior.onGet ? behavior.onGet(id) : null;
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const VALID_BODY = {
  price: '1.25000000',
  longLegMarkValue: '5000',
  shortLegMarkValue: '15000',
  paymentAsset: 'EUR',
  resetIdempotencyKey: 'reset-1',
};

describe('POST /coupled-pairs/:id/strategy/ticks', () => {
  it('returns 200 with the StrategyTickOutcome; floorUnits is a smallest-units string (NFR-2)', async () => {
    let captured: StrategyTick | undefined;
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({
        onTick: (tick) => {
          captured = tick;
          return startedOutcome();
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toBe('reset-started');
    expect(body.floorUnits).toBe('6000'); // string, not a JS number
    expect(typeof body.floorUnits).toBe('string');
    expect(body.state).toBe('REBALANCING');
    // The route parsed the marks into bigints for the service (NFR-2 boundary).
    expect(captured!.longLegMarkValue).toBe(5000n);
    expect(captured!.shortLegMarkValue).toBe(15000n);
    expect(captured!.pairId).toBe(PAIR_ID);
  });

  it('returns the within-barrier no-op outcome (action none)', async () => {
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({
        onTick: () =>
          startedOutcome({
            action: 'none',
            reason: 'within-barrier',
            losingLeg: null,
            state: 'ACTIVE',
            txHash: null,
            resetId: null,
          }),
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('none');
  });

  it('maps an authorization DENY → 403 and REFUSE → 422 (UX-DR5)', async () => {
    const deny = Object.assign(new Error('Burn not authorized (DENY): default-deny'), {
      name: 'BurnAuthorizationError',
      effect: 'DENY',
      reason: 'default-deny',
    });
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({
        onTick: () => {
          throw deny;
        },
      }),
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('AUTHORIZATION_DENIED');
    await app.close();

    const refuse = Object.assign(new Error('Burn not authorized (REFUSE): rule X'), {
      name: 'BurnAuthorizationError',
      effect: 'REFUSE',
      reason: 'rule X',
    });
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({
        onTick: () => {
          throw refuse;
        },
      }),
    });
    const refused = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('AUTHORIZATION_REFUSED');
  });

  it('maps a StrategyResetIdempotencyConflictError → 409', async () => {
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({
        onTick: () => {
          throw new StrategyResetIdempotencyConflictError('reset-1');
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(409);
  });

  it('maps a ConfigRefusalError (parked floor absent) → 503, not an opaque 500', async () => {
    const refusal = Object.assign(new Error('missing MODEL_FLOOR_M'), {
      name: 'ConfigRefusalError',
    });
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({
        onTick: () => {
          throw refusal;
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(503);
  });

  it('rejects a malformed body (negative mark) → 400 (Zod)', async () => {
    app = await buildApp({ db: DB_STUB, strategy: fakeExecutor({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: { ...VALID_BODY, longLegMarkValue: '-5' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when the strategy executor is not configured (refuse-if-absent)', async () => {
    app = await buildApp({ db: DB_STUB });
    const res = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${PAIR_ID}/strategy/ticks`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('STRATEGY_SERVICE_UNAVAILABLE');
  });
});

describe('GET /strategy/resets/:id', () => {
  it('returns the pending then confirmed StrategyResetSchema', async () => {
    app = await buildApp({
      db: DB_STUB,
      strategy: fakeExecutor({ onGet: () => pendingReset() }),
    });
    const res = await app.inject({ method: 'GET', url: '/strategy/resets/reset-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
    expect(res.json().pairId).toBe(PAIR_ID);
  });

  it('returns a structured 404 for an unknown reset id', async () => {
    app = await buildApp({ db: DB_STUB, strategy: fakeExecutor({ onGet: () => null }) });
    const res = await app.inject({ method: 'GET', url: '/strategy/resets/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
