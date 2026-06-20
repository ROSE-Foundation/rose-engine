// Story 9.6 — the `GET /mode` engine-mode report proven IN-PROCESS via Fastify `inject`. It asserts the
// mode + honest real/mocked arrays are DERIVED FROM THE ACTUAL COMPOSED DEPS (the same build-with/without
// pattern the 503-gated route tests use): the faithful ports ⇒ `faithful`; the write services without
// them ⇒ `paper`; neither ⇒ `read-only`. NO DB, NO chain.
import type { RoseDb } from '@rose/ledger';
import type { PositionService } from '@rose/positions';
import type { SubscriptionService } from '@rose/rose-note';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type ApiDeps } from '../app.js';
import { makeFaithfulConfirmationSettingsStore } from '../faithful/confirmation-settings.js';
import { makeMockKycRegistry } from '../faithful/kyc-registry.js';

const DB_STUB = {} as RoseDb;
// Minimal port stubs — `/mode` only inspects PRESENCE (deriveEngineMode never calls into them).
const SUBSCRIPTIONS_STUB = {} as SubscriptionService;
const POSITION_SERVICE_STUB = {} as PositionService;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface ModeBody {
  engineMode: 'paper' | 'faithful' | 'read-only';
  real: string[];
  mocked: string[];
}

async function getMode(deps: ApiDeps): Promise<ModeBody> {
  app = await buildApp(deps);
  const res = await app.inject({ method: 'GET', url: '/mode' });
  expect(res.statusCode).toBe(200);
  return res.json() as ModeBody;
}

describe('GET /mode (Story 9.6, FR-33)', () => {
  it('reports `faithful` with the real/mocked arrays when the faithful deps are composed', async () => {
    const body = await getMode({
      db: DB_STUB,
      subscriptions: SUBSCRIPTIONS_STUB,
      positionService: POSITION_SERVICE_STUB,
      kycRegistry: makeMockKycRegistry(),
      confirmationSettings: makeFaithfulConfirmationSettingsStore(),
    });

    expect(body.engineMode).toBe('faithful');
    // REAL names the genuine guarantees (default-deny gate + reconcile + contracts).
    expect(body.real.some((r) => /default-deny authorization gate/i.test(r))).toBe(true);
    expect(body.real.some((r) => /reconciliation/i.test(r))).toBe(true);
    expect(body.real.some((r) => /contracts/i.test(r))).toBe(true);
    // MOCKED names the simulated externals (confirmation latency + KYC issuer + counterparty + price feed).
    expect(body.mocked.some((m) => /confirmation latency/i.test(m))).toBe(true);
    expect(body.mocked.some((m) => /KYC\/AML claim issuer/i.test(m))).toBe(true);
    expect(body.mocked.some((m) => /counterparty/i.test(m))).toBe(true);
    expect(body.mocked.some((m) => /price feed/i.test(m))).toBe(true);
  });

  it('reports `paper` when the write services are composed WITHOUT the faithful deps', async () => {
    const body = await getMode({
      db: DB_STUB,
      subscriptions: SUBSCRIPTIONS_STUB,
      positionService: POSITION_SERVICE_STUB,
    });

    expect(body.engineMode).toBe('paper');
    // Paper's mocked list is honest to paper's shortcuts (instant auto-confirm, paper ALLOW) — NOT
    // faithful's default-deny gate / KYC issuer.
    expect(body.mocked.some((m) => /auto-confirm/i.test(m))).toBe(true);
    expect(body.mocked.some((m) => /paper ALLOW/i.test(m))).toBe(true);
    expect(body.real.some((r) => /ledger/i.test(r))).toBe(true);
  });

  it('reports `read-only` when no write services are composed (mocked is empty)', async () => {
    const body = await getMode({ db: DB_STUB });

    expect(body.engineMode).toBe('read-only');
    expect(body.mocked).toEqual([]);
    expect(body.real.length).toBeGreaterThan(0);
  });
});
