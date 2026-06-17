// Shared live-environment server gate (infrastructure). Proves the single basic-auth gate end-to-end
// via Fastify `inject` (no socket, no real DB): every route — an API route, the OpenAPI document, the
// static front-end, and the SPA fallback — is protected, and the boot REFUSES when the credentials
// (or DATABASE_URL) are absent (refuse-if-absent, NFR-4). The gate is exercised with a stub `db`
// because the asserted routes (/health, /openapi.json, static) never touch the ledger.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoseDb } from '@rose/ledger';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiDeps } from './app.js';
import {
  buildServer,
  loadBasicAuthCredentials,
  requireDatabaseUrl,
  ServerConfigRefusalError,
} from './serve.js';

const USER = 'demo-user';
const PASSWORD = 'demo-secret-pw';
const INDEX_HTML = '<!doctype html><title>ROSE Engine</title><div id="root">demo</div>';

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

let webDistDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  webDistDir = mkdtempSync(join(tmpdir(), 'rose-web-'));
  writeFileSync(join(webDistDir, 'index.html'), INDEX_HTML);
  const deps: ApiDeps = { db: {} as RoseDb };
  app = await buildServer({ deps, credentials: { user: USER, password: PASSWORD }, webDistDir });
});

afterAll(async () => {
  await app?.close();
  if (webDistDir) rmSync(webDistDir, { recursive: true, force: true });
});

describe('refuse-if-absent — the server never boots unprotected', () => {
  it('loadBasicAuthCredentials throws when BOTH credentials are absent', () => {
    expect(() => loadBasicAuthCredentials({})).toThrow(ServerConfigRefusalError);
  });

  it('loadBasicAuthCredentials throws when only the password is absent (names it)', () => {
    try {
      loadBasicAuthCredentials({ BASIC_AUTH_USER: USER });
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ServerConfigRefusalError);
      expect((err as ServerConfigRefusalError).missing).toEqual(['BASIC_AUTH_PASSWORD']);
    }
  });

  it('loadBasicAuthCredentials throws when an empty-string credential is supplied', () => {
    expect(() =>
      loadBasicAuthCredentials({ BASIC_AUTH_USER: '  ', BASIC_AUTH_PASSWORD: 'x' }),
    ).toThrow(ServerConfigRefusalError);
  });

  it('requireDatabaseUrl throws when DATABASE_URL is absent', () => {
    expect(() => requireDatabaseUrl({})).toThrow(ServerConfigRefusalError);
  });

  it('loadBasicAuthCredentials returns the credentials when both are present', () => {
    expect(
      loadBasicAuthCredentials({ BASIC_AUTH_USER: USER, BASIC_AUTH_PASSWORD: PASSWORD }),
    ).toEqual({ user: USER, password: PASSWORD });
  });
});

describe('the basic-auth gate protects every route', () => {
  it('an API route (GET /health) is 401 without an Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(401);
  });

  it('the OpenAPI document (GET /openapi.json) is 401 without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(401);
  });

  it('the static front-end (GET /index.html) is 401 without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(401);
  });

  it('the SPA fallback (GET /some/deep/link) is 401 without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/covenant-console' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects WRONG credentials with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: basic(USER, 'wrong-password') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid-format header with an unknown user with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: basic('not-the-user', PASSWORD) },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('with the correct credentials the gate passes through', () => {
  const auth = { authorization: basic(USER, PASSWORD) };

  it('serves the API route (GET /health → 200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('serves the OpenAPI document (GET /openapi.json → 200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\./);
  });

  it('serves the static front-end shell (GET /index.html → 200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/index.html', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ROSE Engine');
  });

  it('falls back to the SPA shell for an unmatched deep link (GET → 200 index.html)', async () => {
    const res = await app.inject({ method: 'GET', url: '/covenant-console', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });
});
