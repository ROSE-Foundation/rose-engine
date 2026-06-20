// Story 9.2 — the faithful onboarding HTTP contract proven IN-PROCESS via Fastify `inject` over a real
// in-memory `MockKycRegistry` (NO DB, NO chain). Asserts: onboard/revoke round-trip with the
// `OnboardingState` shape; a state read; a malformed address ⇒ 400 (Zod fail-closed); and — when the
// registry is NOT wired (non-faithful deployment) — a typed 503 `FAITHFUL_ONBOARDING_UNAVAILABLE`.
import type { RoseDb } from '@rose/ledger';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { makeMockKycRegistry } from '../faithful/kyc-registry.js';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DB_STUB = {} as RoseDb;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /faithful/onboarding', () => {
  it('onboards then revokes an address (round-trip), returning the new OnboardingState', async () => {
    const kycRegistry = makeMockKycRegistry();
    app = await buildApp({ db: DB_STUB, kycRegistry });

    const onboard = await app.inject({
      method: 'POST',
      url: '/faithful/onboarding',
      payload: { address: ALICE, action: 'onboard' },
    });
    expect(onboard.statusCode).toBe(200);
    const onboardBody = onboard.json() as { onboarded: boolean; version: number; address: string };
    expect(onboardBody.onboarded).toBe(true);
    expect(onboardBody.version).toBe(1);
    expect(kycRegistry.isOnboarded(ALICE)).toBe(true);

    const revoke = await app.inject({
      method: 'POST',
      url: '/faithful/onboarding',
      payload: { address: ALICE, action: 'revoke' },
    });
    expect(revoke.statusCode).toBe(200);
    expect((revoke.json() as { onboarded: boolean }).onboarded).toBe(false);
    expect(kycRegistry.isOnboarded(ALICE)).toBe(false);
  });

  it('reads an address state via GET /faithful/onboarding/:address', async () => {
    const kycRegistry = makeMockKycRegistry([ALICE]);
    app = await buildApp({ db: DB_STUB, kycRegistry });
    const res = await app.inject({ method: 'GET', url: `/faithful/onboarding/${ALICE}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { onboarded: boolean }).onboarded).toBe(true);
  });

  it('refuses a malformed address with a 400 (Zod fail-closed)', async () => {
    app = await buildApp({ db: DB_STUB, kycRegistry: makeMockKycRegistry() });
    const res = await app.inject({
      method: 'POST',
      url: '/faithful/onboarding',
      payload: { address: '0x123', action: 'onboard' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns a typed 503 when the KYC registry is NOT wired (non-faithful deployment)', async () => {
    app = await buildApp({ db: DB_STUB }); // no kycRegistry
    const res = await app.inject({
      method: 'POST',
      url: '/faithful/onboarding',
      payload: { address: ALICE, action: 'onboard' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'FAITHFUL_ONBOARDING_UNAVAILABLE',
    );
  });
});
