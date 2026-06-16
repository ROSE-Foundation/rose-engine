import { describe, expect, it } from 'vitest';
import * as authorization from './index.js';

// Guards the public surface so Story 3.3 (`postTransfer`) and Story 3.4 (production provider) have a
// complete barrel to consume.
describe('@rose/authorization public surface', () => {
  it('exports the package identifier', () => {
    expect(authorization.AUTHORIZATION_PACKAGE_NAME).toBe('@rose/authorization');
  });

  it('exports the fail-closed default vocabulary', () => {
    expect(authorization.DEFAULT_EFFECT).toBe('DENY');
    expect(typeof authorization.denyByDefault).toBe('function');
    expect(authorization.denyByDefault().effect).toBe('DENY');
  });

  it('exports both provider factories', () => {
    expect(typeof authorization.makeDefaultDenyProvider).toBe('function');
    expect(typeof authorization.makePolicyAuthorizationProvider).toBe('function');
  });

  it('exports the conformance bridge and gate', () => {
    expect(typeof authorization.providerToPlaneAdapter).toBe('function');
    expect(typeof authorization.assertProviderConforms).toBe('function');
  });
});
