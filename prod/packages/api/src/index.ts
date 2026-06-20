// @rose/api — the typed REST API boundary (Story 6.1, FR-14 foundation). Fastify + Zod + OpenAPI:
// `buildApp(deps)` returns a Fastify app whose request/response schemas are Zod (the single source
// of the I/O types, from which `@fastify/swagger` derives the OpenAPI document), money is serialized
// as decimal strings (NFR-2), and domain/authorization refusals surface through one structured-error
// translator with the correct HTTP status and a specific named-rule code (UX-DR5). Dependencies are
// INJECTED (the ledger `RoseDb`, an optional `ChainSupplySnapshot`); the app opens no DB pool and no
// socket, so it is exercised in-process via Fastify `inject`. Base endpoints are READ-ONLY over
// existing Epic 1–5 state; the live write paths + UI are Stories 6.2→6.6.
export {
  buildApp,
  installErrorHandling,
  type ApiDeps,
  type MarkTrustInputs,
  type OpenApiInfo,
} from './app.js';

export {
  ApiError,
  NotFoundError,
  mapErrorToResponse,
  type MappedErrorResponse,
  type StructuredErrorBody,
} from './errors.js';

export {
  noFeedMarkResponse,
  serializeCoupledPair,
  serializeMark,
  serializePosition,
  serializeRoseNote,
  type CoupledPairResponse,
  type PositionMarkResponse,
  type PositionResponse,
  type RoseNoteResponse,
} from './serializers.js';

// Type-only re-exports of the consolidated group-view wire type (the `z.infer` of `GroupViewSchema`)
// and the Rose Note subscription/redemption write wire types (Story 6.6) + the per-user position +
// live-mark wire types (Story 8.4), so surface consumers (`@rose/web`) bind to the SAME single-source
// contract types with a fully-erased `import type` (no runtime edge, no Fastify in the browser
// bundle). Additive, runtime-inert.
export type {
  GroupViewResponse,
  OnboardingRequest,
  OnboardingState,
  PositionsResponse,
  RedeemRequest,
  RedemptionResponse,
  SubscribeRequest,
  SubscriptionResponse,
} from './schemas.js';

// Faithful-mode mock KYC/AML onboarding (Story 9.2, FR-29): the registry seam + its onboarding schemas.
export {
  makeMockKycRegistry,
  InvalidKycAddressError,
  type MockKycRegistry,
  type KycOnboardingState,
} from './faithful/kyc-registry.js';
export {
  makeKycAuthorizationGate,
  makeKycEligibilityProvider,
  decideKycAuthorization,
  runWithKycContext,
  KYC_DEFAULT_DENY_RULE,
  type KycAuthorizationContext,
} from './faithful/faithful-authorization.js';
export {
  makeMockCounterpartyAdapter,
  MOCK_HOUSE_OWNER,
  type MockCounterpartyConfig,
} from './faithful/counterparty-mock.js';
export {
  OnboardingAddressParamSchema,
  OnboardingRequestSchema,
  OnboardingStateSchema,
} from './schemas.js';

// Engine-mode reporting (Story 9.6, FR-33): the honest real-vs-mocked report driver + its wire schema
// and type (so the web mode banner binds to the SAME single-source contract type via a fully-erased
// `import type`). `GET /mode` returns `deriveEngineMode(deps)`, derived from the actual composition.
export { deriveEngineMode } from './engine-mode.js';
export { EngineModeSchema, EngineModeInfoSchema, type EngineModeInfo } from './schemas.js';

// Operator control panel (Story 9.5, FR-32): the faithful-mode covenant-breach + reconcile-divergence
// injection stores + the operator wire schemas/types (so the web operator surface binds to the SAME
// single-source contract types via a fully-erased `import type`).
export {
  makeFaithfulCovenantOverrideStore,
  type FaithfulCovenantOverrideStore,
  type FaithfulCovenantOverrideState,
} from './faithful/covenant-override.js';
export {
  makeFaithfulReconcileInjectionStore,
  type FaithfulReconcileInjectionStore,
  type FaithfulReconcileInjectionState,
} from './faithful/reconcile-injection.js';
export type {
  FaithfulConfirmationSettingsView,
  FaithfulConfirmationSettingsUpdate,
  OperatorInjectionState,
  OperatorInjectionUpdate,
} from './schemas.js';

export {
  AccountTypeSchema,
  CoupledPairSchema,
  CoupledPairStateSchema,
  EntityCodeSchema,
  ErrorResponseSchema,
  GroupViewSchema,
  HealthSchema,
  IdParamSchema,
  LegSideSchema,
  MoneySchema,
  MarkStatusSchema,
  NavRoleSchema,
  PositionLifecycleSchema,
  PositionMarkSchema,
  PositionSchema,
  PositionSideSchema,
  PositionsQuerySchema,
  PositionsResponseSchema,
  PostingDirectionSchema,
  RedeemRequestSchema,
  RedemptionIdParamSchema,
  RedemptionSchema,
  RedemptionStatusSchema,
  RoseNoteSchema,
  SourceSchema,
  StrategyResetIdParamSchema,
  StrategyResetSchema,
  StrategyResetStatusSchema,
  StrategyTickOutcomeSchema,
  StrategyTickRequestSchema,
  SubscribeRequestSchema,
  SubscriptionIdParamSchema,
  SubscriptionSchema,
  SubscriptionStatusSchema,
} from './schemas.js';
