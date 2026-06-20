// Faithful KYC/AML onboarding routes (Story 9.2, FR-29). The control surface over the mock ONCHAINID
// claim issuer (`MockKycRegistry`): `POST /faithful/onboarding` issues / revokes an eligibility claim
// for an address; `GET /faithful/onboarding/:address` reads its state. Composed ONLY when the KYC
// registry is wired (ENGINE_MODE=faithful) — mirrors the paper-gated `routes/simulation.ts` 503
// pattern: a non-faithful / read-only deployment returns a typed 503 (refuse-if-absent). The address is
// Zod-validated as a 20-byte EVM address (fail-closed: a malformed address ⇒ 400 BEFORE any state change).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError } from '../errors.js';
import type { MockKycRegistry } from '../faithful/kyc-registry.js';
import {
  ErrorResponseSchema,
  OnboardingAddressParamSchema,
  OnboardingRequestSchema,
  OnboardingStateSchema,
} from '../schemas.js';

/** Resolve the mock KYC registry, or refuse with a typed 503 (composed only in faithful mode). */
function requireKycRegistry(deps: ApiDeps): MockKycRegistry {
  if (deps.kycRegistry === undefined) {
    throw new ApiError(
      503,
      'FAITHFUL_ONBOARDING_UNAVAILABLE',
      'The mocked KYC/AML onboarding is not configured on this deployment (faithful composition not ' +
        'wired). Set ENGINE_MODE=faithful for the default-deny + KYC gated environment.',
    );
  }
  return deps.kycRegistry;
}

export function faithfulOnboardingRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/faithful/onboarding',
      {
        schema: {
          summary: 'Onboard or revoke an address in the mocked KYC/AML registry (faithful mode)',
          tags: ['faithful'],
          body: OnboardingRequestSchema,
          response: {
            200: OnboardingStateSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const registry = requireKycRegistry(deps);
        const { address, action } = request.body;
        // The address is already EIP-55-validated by Zod; the registry normalises + applies the action.
        return action === 'onboard' ? registry.onboard(address) : registry.revoke(address);
      },
    );

    app.get(
      '/faithful/onboarding/:address',
      {
        schema: {
          summary:
            'Read an address onboarding state in the mocked KYC/AML registry (faithful mode)',
          tags: ['faithful'],
          params: OnboardingAddressParamSchema,
          response: {
            200: OnboardingStateSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const registry = requireKycRegistry(deps);
        return registry.state(request.params.address);
      },
    );
  };
}
