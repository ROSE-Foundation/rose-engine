// Operator control panel routes (Story 9.5, FR-32). The faithful-mode control surface for injecting
// production-like events on demand, so prod-state handling is demonstrable LIVE:
//   1. Confirmation latency / failure (wired to Story 9.1) — GET/PUT the SAME confirmation-settings
//      store the async transport consumes; setting latencyMs/failureRate/failNext shapes the next
//      flow's delayed-commit / compensated-failure behaviour (this story only EXPOSES the store).
//   2. Covenant breach — a toggle the REAL group-view covenant computation consults (genuine BREACH).
//   3. Reconcile divergence — a toggle so the NEXT POST /positions/reconcile reports-and-corrects a
//      divergence through the REAL Story-8.5 path (journaled, surfaced).
// Composed ONLY in ENGINE_MODE=faithful; a non-faithful / read-only deployment returns a typed 503 —
// mirroring the paper-gated `routes/simulation.ts`. Inputs are Zod-validated fail-closed (out-of-range
// confirmation patch ⇒ 400 via the FaithfulConfirmationSettingsError registry mapping).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../app.js';
import { ApiError } from '../errors.js';
import type { FaithfulConfirmationSettingsStore } from '../faithful/confirmation-settings.js';
import type { FaithfulCovenantOverrideStore } from '../faithful/covenant-override.js';
import type { FaithfulReconcileInjectionStore } from '../faithful/reconcile-injection.js';
import {
  ErrorResponseSchema,
  FaithfulConfirmationSettingsUpdateSchema,
  FaithfulConfirmationSettingsViewSchema,
  OperatorInjectionStateSchema,
  OperatorInjectionUpdateSchema,
} from '../schemas.js';

/** Resolve the confirmation-settings store, or refuse with a typed 503 (composed only in faithful mode). */
function requireConfirmationSettings(deps: ApiDeps): FaithfulConfirmationSettingsStore {
  if (deps.confirmationSettings === undefined) {
    throw new ApiError(
      503,
      'OPERATOR_CONFIRMATION_UNAVAILABLE',
      'The operator confirmation-settings control is not configured on this deployment (faithful ' +
        'composition not wired). Set ENGINE_MODE=faithful for the async-confirmation environment.',
    );
  }
  return deps.confirmationSettings;
}

/** Resolve the covenant-breach override store, or refuse with a typed 503 (faithful mode only). */
function requireCovenantOverride(deps: ApiDeps): FaithfulCovenantOverrideStore {
  if (deps.covenantOverride === undefined) {
    throw new ApiError(
      503,
      'OPERATOR_COVENANT_UNAVAILABLE',
      'The operator covenant-breach injection is not configured on this deployment (faithful ' +
        'composition not wired). Set ENGINE_MODE=faithful.',
    );
  }
  return deps.covenantOverride;
}

/** Resolve the reconcile-divergence injection store, or refuse with a typed 503 (faithful mode only). */
function requireReconcileInjection(deps: ApiDeps): FaithfulReconcileInjectionStore {
  if (deps.reconcileInjection === undefined) {
    throw new ApiError(
      503,
      'OPERATOR_RECONCILE_UNAVAILABLE',
      'The operator reconcile-divergence injection is not configured on this deployment (faithful ' +
        'composition not wired). Set ENGINE_MODE=faithful.',
    );
  }
  return deps.reconcileInjection;
}

export function operatorRoutes(deps: ApiDeps): FastifyPluginAsyncZod {
  return async (app) => {
    // ─── 1. Confirmation latency / failure injection (wired to Story 9.1) ──────────────────────────
    app.get(
      '/operator/confirmation',
      {
        schema: {
          summary: 'Read the faithful async-confirmation settings (latency + failure injection)',
          tags: ['operator'],
          response: {
            200: FaithfulConfirmationSettingsViewSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async () => requireConfirmationSettings(deps).get(),
    );

    app.put(
      '/operator/confirmation',
      {
        schema: {
          summary: 'Inject confirmation latency / a "fail next" / a failure rate (faithful mode)',
          tags: ['operator'],
          body: FaithfulConfirmationSettingsUpdateSchema,
          response: {
            200: FaithfulConfirmationSettingsViewSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const store = requireConfirmationSettings(deps);
        // FaithfulConfirmationSettingsError (out-of-range) is mapped to 400 by the error registry.
        return store.set(request.body);
      },
    );

    // ─── 2. Covenant-breach injection (real group-view covenant computation) ───────────────────────
    app.get(
      '/operator/covenant-breach',
      {
        schema: {
          summary: 'Read the covenant-breach injection state (faithful mode)',
          tags: ['operator'],
          response: { 200: OperatorInjectionStateSchema, 503: ErrorResponseSchema },
        },
      },
      async () => requireCovenantOverride(deps).get(),
    );

    app.put(
      '/operator/covenant-breach',
      {
        schema: {
          summary:
            'Force / clear a genuine covenant BREACH on the group-view monitor (faithful mode)',
          tags: ['operator'],
          body: OperatorInjectionUpdateSchema,
          response: {
            200: OperatorInjectionStateSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => requireCovenantOverride(deps).set(request.body.active),
    );

    // ─── 3. Reconcile-divergence injection (real Story-8.5 reconcile-and-correct) ──────────────────
    app.get(
      '/operator/reconcile-divergence',
      {
        schema: {
          summary: 'Read the reconcile-divergence injection state (faithful mode)',
          tags: ['operator'],
          response: { 200: OperatorInjectionStateSchema, 503: ErrorResponseSchema },
        },
      },
      async () => requireReconcileInjection(deps).get(),
    );

    app.put(
      '/operator/reconcile-divergence',
      {
        schema: {
          summary:
            'Arm / clear a position↔pair reconciliation divergence on the next reconcile (faithful mode)',
          tags: ['operator'],
          body: OperatorInjectionUpdateSchema,
          response: {
            200: OperatorInjectionStateSchema,
            400: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => requireReconcileInjection(deps).set(request.body.active),
    );
  };
}
