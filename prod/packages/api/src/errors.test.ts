// Unit tests for the structured-error mapper (Story 6.1, AC-2). Pure — NO DB, NO HTTP. Proves every
// mapped status (403/422/409/404/503/400-path/500) and the UX-DR5 contract: refusals carry a
// SPECIFIC machine code + reason, an unknown error NEVER leaks its message, and the body is always
// `{ error: { code, message, details? } }`.
import { describe, expect, it } from 'vitest';
import { ApiError, NotFoundError, mapErrorToResponse } from './errors.js';

// A minimal stand-in for a thrown domain error: the mapper keys on `name` (every codebase error
// class sets `this.name`), so a plain object with the right `name` exercises the registry exactly.
function named(name: string, message = `${name} occurred`): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('mapErrorToResponse — authorization split (UX-DR5)', () => {
  it('maps TransferRefusedError DENY → 403 AUTHORIZATION_DENIED with the reason', () => {
    const err = Object.assign(new Error('Transfer DENY: default-deny (no rule allowed)'), {
      name: 'TransferRefusedError',
      effect: 'DENY',
      reason: 'default-deny (no rule allowed)',
    });
    const { status, body } = mapErrorToResponse(err);
    expect(status).toBe(403);
    expect(body.error.code).toBe('AUTHORIZATION_DENIED');
    expect(body.error.message).toContain('default-deny');
    expect(body.error.details).toEqual({ reason: 'default-deny (no rule allowed)' });
  });

  it('maps TransferRefusedError REFUSE → 422 AUTHORIZATION_REFUSED', () => {
    const err = Object.assign(new Error('Transfer REFUSE: model-A bright line'), {
      name: 'TransferRefusedError',
      effect: 'REFUSE',
      reason: 'model-A bright line',
    });
    const { status, body } = mapErrorToResponse(err);
    expect(status).toBe(422);
    expect(body.error.code).toBe('AUTHORIZATION_REFUSED');
    expect(body.error.message).toContain('model-A');
  });

  it('fails closed to 403 when a TransferRefusedError carries an unknown effect', () => {
    const err = Object.assign(new Error('weird'), { name: 'TransferRefusedError', effect: 'XYZ' });
    expect(mapErrorToResponse(err).status).toBe(403);
  });
});

describe('mapErrorToResponse — domain (422) / conflict (409) / not-found (404) / config (503)', () => {
  it.each([
    'NotDeltaNeutralError',
    'InvalidCoupledPairError',
    'InvalidPairAmountError',
    'SingleLegIssuanceError',
    'InvalidTransferError',
    'AccountPlacementError',
    'MintAuthorizationError',
  ])('maps %s → 422 with the error name as the specific code', (name) => {
    const { status, body } = mapErrorToResponse(named(name));
    expect(status).toBe(422);
    expect(body.error.code).toBe(name);
  });

  it.each([
    'UnbalancedEntryError',
    'IllegalPairTransitionError',
    'IllegalOutboxTransitionError',
    'UnreconciledDivergenceError',
  ])('maps %s → 409', (name) => {
    expect(mapErrorToResponse(named(name)).status).toBe(409);
  });

  it.each(['CoupledPairNotFoundError', 'AccountNotFoundError', 'OutboxEventNotFoundError'])(
    'maps %s → 404',
    (name) => {
      expect(mapErrorToResponse(named(name)).status).toBe(404);
    },
  );

  it.each(['ConfigRefusalError', 'ChainConfigRefusalError'])('maps %s → 503', (name) => {
    expect(mapErrorToResponse(named(name)).status).toBe(503);
  });

  it('maps SolvencyGuardrailError → 409 SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED (Story 8.6, UX-DR5)', () => {
    const { status, body } = mapErrorToResponse(
      named(
        'SolvencyGuardrailError',
        '§11.4 solvency guardrail: independent single-side close … burned ONLY when BOTH sides are released.',
      ),
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED');
    expect(body.error.message).toContain('§11.4');
  });
});

describe('mapErrorToResponse — Story 6.2 subscription write-path classes', () => {
  it('maps IneligibleSubscriberError → 403 SUBSCRIBER_NOT_ELIGIBLE (FR-19 recipient rejection)', () => {
    const { status, body } = mapErrorToResponse(
      named('IneligibleSubscriberError', 'Subscriber not eligible: no valid ONCHAINID claim'),
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('SUBSCRIBER_NOT_ELIGIBLE');
    expect(body.error.message).toContain('ONCHAINID');
  });

  it('maps RoseNoteNotFoundError → 404', () => {
    expect(mapErrorToResponse(named('RoseNoteNotFoundError')).status).toBe(404);
  });

  it.each(['SubscriptionPairNotActiveError', 'SubscriptionIdempotencyConflictError'])(
    'maps %s → 409 (lifecycle / idempotency conflict)',
    (name) => {
      expect(mapErrorToResponse(named(name)).status).toBe(409);
    },
  );

  it('splits MintAuthorizationError on effect: DENY → 403, REFUSE → 422 (UX-DR5 consistency)', () => {
    const deny = Object.assign(new Error('Mint not authorized (DENY): default-deny'), {
      name: 'MintAuthorizationError',
      effect: 'DENY',
      reason: 'default-deny',
    });
    const denied = mapErrorToResponse(deny);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTHORIZATION_DENIED');

    const refuse = Object.assign(new Error('Mint not authorized (REFUSE): rule X'), {
      name: 'MintAuthorizationError',
      effect: 'REFUSE',
      reason: 'rule X',
    });
    const refused = mapErrorToResponse(refuse);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('AUTHORIZATION_REFUSED');
  });

  it('maps an effect-less MintAuthorizationError → 422 via the name registry (preserved)', () => {
    const { status, body } = mapErrorToResponse(named('MintAuthorizationError'));
    expect(status).toBe(422);
    expect(body.error.code).toBe('MintAuthorizationError');
  });

  it.each(['UnsupportedPaymentAssetError', 'InvalidSubscriptionAmountError'])(
    'maps %s → 422',
    (name) => {
      expect(mapErrorToResponse(named(name)).status).toBe(422);
    },
  );
});

describe('mapErrorToResponse — Story 6.3 redemption write-path classes', () => {
  it.each(['RedemptionPairNotActiveError', 'RedemptionIdempotencyConflictError'])(
    'maps %s → 409 (lifecycle / idempotency conflict)',
    (name) => {
      expect(mapErrorToResponse(named(name)).status).toBe(409);
    },
  );

  it('maps InvalidRedemptionAmountError → 422', () => {
    expect(mapErrorToResponse(named('InvalidRedemptionAmountError')).status).toBe(422);
  });

  it('splits BurnAuthorizationError on effect: DENY → 403, REFUSE → 422 (UX-DR5 consistency)', () => {
    const deny = Object.assign(new Error('Burn not authorized (DENY): default-deny'), {
      name: 'BurnAuthorizationError',
      effect: 'DENY',
      reason: 'default-deny',
    });
    const denied = mapErrorToResponse(deny);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTHORIZATION_DENIED');

    const refuse = Object.assign(new Error('Burn not authorized (REFUSE): rule X'), {
      name: 'BurnAuthorizationError',
      effect: 'REFUSE',
      reason: 'rule X',
    });
    const refused = mapErrorToResponse(refuse);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('AUTHORIZATION_REFUSED');
  });

  it('maps an effect-less BurnAuthorizationError → 422 via the name registry (preserved)', () => {
    const { status, body } = mapErrorToResponse(named('BurnAuthorizationError'));
    expect(status).toBe(422);
    expect(body.error.code).toBe('BurnAuthorizationError');
  });
});

describe('mapErrorToResponse — Story 6.4 strategy write-path classes', () => {
  it.each(['StrategyResetIdempotencyConflictError', 'CoupledPairResetStateError'])(
    'maps %s → 409 (idempotency / reset-window conflict)',
    (name) => {
      expect(mapErrorToResponse(named(name)).status).toBe(409);
    },
  );

  it('maps InvalidStrategyResetError → 422', () => {
    expect(mapErrorToResponse(named('InvalidStrategyResetError')).status).toBe(422);
  });

  it('maps CoupledPairNotFoundError → 404 and ConfigRefusalError → 503 (parked floor refuse-if-absent)', () => {
    expect(mapErrorToResponse(named('CoupledPairNotFoundError')).status).toBe(404);
    expect(mapErrorToResponse(named('ConfigRefusalError')).status).toBe(503);
  });
});

describe('mapErrorToResponse — API errors and the non-leaking fallback', () => {
  it('uses an ApiError’s own status/code/message/details', () => {
    const { status, body } = mapErrorToResponse(
      new ApiError(418, 'TEAPOT', 'short and stout', { x: 1 }),
    );
    expect(status).toBe(418);
    expect(body.error).toEqual({ code: 'TEAPOT', message: 'short and stout', details: { x: 1 } });
  });

  it('maps NotFoundError → 404 NOT_FOUND', () => {
    const { status, body } = mapErrorToResponse(new NotFoundError('gone', { id: 'abc' }));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ id: 'abc' });
  });

  it('maps an unknown error → generic 500 and NEVER leaks its message', () => {
    const { status, body } = mapErrorToResponse(new Error('SECRET internal detail at /var/db'));
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('maps a non-error throw (string/null) → generic 500', () => {
    expect(mapErrorToResponse('boom').status).toBe(500);
    expect(mapErrorToResponse(null).status).toBe(500);
  });

  it('always returns the { error: { code, message } } envelope', () => {
    for (const sample of [named('UnbalancedEntryError'), new Error('x'), new NotFoundError('y')]) {
      const { body } = mapErrorToResponse(sample);
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    }
  });
});
