// @rose/authorization — the fail-closed baseline provider (Story 3.2, AC-1, NFR-4).
//
// This is the provider a caller gets when no policy is configured: it DENIES every request,
// never throws, and never defaults to allow. It is intentionally NOT conformant against the
// ALLOW conformance vectors — being maximally safe is the point. Reproducing the real rule
// decisions (and thus passing the shared vectors) is the job of a policy-backed provider.
import type { AuthorizationProvider } from './authorization-provider.js';
import { denyByDefault } from './authorization-provider.js';

/** Build a provider that denies every transfer — the fail-closed default seam. */
export function makeDefaultDenyProvider(name = 'default-deny'): AuthorizationProvider {
  return {
    name,
    authorize() {
      return denyByDefault();
    },
  };
}
