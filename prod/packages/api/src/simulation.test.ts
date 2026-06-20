// The /simulation/settings routes proven IN-PROCESS via Fastify `inject`. Asserts: GET returns the
// settings + bounds; PUT validates against the bounds (400 on out-of-range); and BOTH routes are a
// typed 503 when the store is not composed (read-only / non-paper deployment).
import { createDb, createPool, hardReset, migrateUp, type RoseDb } from '@rose/ledger';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { makeSimulationSettingsStore } from './simulation-settings.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

beforeAll(async () => {
  pool = createPool();
  await hardReset(pool);
  await migrateUp(pool);
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
});

async function appWithStore(): Promise<FastifyInstance> {
  return buildApp({ db, simulationSettings: makeSimulationSettingsStore() });
}

describe('GET /simulation/settings', () => {
  it('returns the current settings, version and bounds', async () => {
    const app = await appWithStore();
    const res = await app.inject({ method: 'GET', url: '/simulation/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.amplitude).toBe('number');
    expect(typeof body.periodSeconds).toBe('number');
    expect(body.version).toBe(0);
    expect(body.bounds).toMatchObject({ amplitudeMax: expect.any(Number) });
    await app.close();
  });

  it('is a typed 503 when the store is not composed (non-paper deployment)', async () => {
    const app = await buildApp({ db });
    const res = await app.inject({ method: 'GET', url: '/simulation/settings' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SIMULATION_SETTINGS_UNAVAILABLE');
    await app.close();
  });
});

describe('PUT /simulation/settings', () => {
  it('applies a valid patch and bumps the version', async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: 'PUT',
      url: '/simulation/settings',
      payload: { amplitude: 0.2, periodSeconds: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amplitude: 0.2, periodSeconds: 30, version: 1 });
    await app.close();
  });

  it('rejects an out-of-range amplitude with a typed 400 (fail-closed, never clamped)', async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: 'PUT',
      url: '/simulation/settings',
      payload: { amplitude: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SimulationSettingsError');
    await app.close();
  });

  it('round-trips a directional-change mode + δ patch', async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: 'PUT',
      url: '/simulation/settings',
      payload: { mode: 'directional-change', dcThreshold: 0.02 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'directional-change',
      dcThreshold: 0.02,
      version: 1,
    });
    await app.close();
  });

  it('rejects an invalid mode enum with a 400', async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: 'PUT',
      url: '/simulation/settings',
      payload: { mode: 'random-walk' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an out-of-range δ with a typed 400 (fail-closed)', async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: 'PUT',
      url: '/simulation/settings',
      payload: { dcThreshold: 0.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SimulationSettingsError');
    await app.close();
  });

  it('is a typed 503 when the store is not composed', async () => {
    const app = await buildApp({ db });
    const res = await app.inject({
      method: 'PUT',
      url: '/simulation/settings',
      payload: { amplitude: 0.1 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SIMULATION_SETTINGS_UNAVAILABLE');
    await app.close();
  });
});
