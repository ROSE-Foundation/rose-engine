import type { AuthorizationRequest } from './authorization-provider.js';
import { DEFAULT_EFFECT, denyByDefault } from './authorization-provider.js';
import { describe, expect, it } from 'vitest';
import { makeDefaultDenyProvider } from './default-deny-provider.js';

// AC-1 (fail-closed): the default-deny provider denies EVERY request — it never returns ALLOW or
// REFUSE, regardless of how "permissible" the flow looks. This is the safe baseline a caller gets
// when no policy is configured (NFR-4).
describe('default-deny provider (AC-1, fail-closed)', () => {
  const provider = makeDefaultDenyProvider();

  // A spread of requests including one that a policy WOULD allow, an uncovered one, and a
  // floor-guarded one — the baseline must DENY all of them.
  const requests: ReadonlyArray<{
    readonly label: string;
    readonly request: AuthorizationRequest;
  }> = [
    {
      label: 'an explicitly-permitted-looking flow (fee income → treasury)',
      request: {
        scenario: {
          from: 'FEE_INCOME',
          classification: 'NONE',
          to: 'TREASURY',
          assetKind: 'VALUE',
        },
        env: {},
      },
    },
    {
      label: 'an uncovered flow (deployed capital → external)',
      request: {
        scenario: {
          from: 'DEPLOYED_CAPITAL',
          classification: 'NONE',
          to: 'EXTERNAL',
          assetKind: 'VALUE',
        },
        env: {},
      },
    },
    {
      label: 'a floor-guarded flow with the floor present and not breached',
      request: {
        scenario: {
          from: 'BACKING_FLOAT',
          classification: 'NONE',
          to: 'EXTERNAL',
          assetKind: 'VALUE',
        },
        env: { backingFloatFloor: 1000n, postBalanceBelowFloor: false },
      },
    },
  ];

  it.each(requests)('denies $label', ({ request }) => {
    const decision = provider.authorize(request);
    expect(decision.effect).toBe('DENY');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('never returns ALLOW or REFUSE for any of the sampled requests', () => {
    const effects = requests.map(({ request }) => provider.authorize(request).effect);
    expect(effects.every((e) => e === 'DENY')).toBe(true);
  });

  it('exposes a stable provider name', () => {
    expect(provider.name).toBe('default-deny');
    expect(makeDefaultDenyProvider('no-policy').name).toBe('no-policy');
  });

  it('the fail-closed default is DENY', () => {
    expect(DEFAULT_EFFECT).toBe('DENY');
    expect(denyByDefault().effect).toBe('DENY');
    expect(denyByDefault('custom reason').reason).toBe('custom reason');
  });

  it('never produces a blank audit reason (empty/whitespace falls back to the default)', () => {
    expect(denyByDefault('').reason.length).toBeGreaterThan(0);
    expect(denyByDefault('   ').reason.length).toBeGreaterThan(0);
  });
});
