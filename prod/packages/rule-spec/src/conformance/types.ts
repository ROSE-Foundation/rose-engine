// @rose/rule-spec — conformance types (Story 3.1).
//
// The conformance layer is plane-agnostic: a shared set of vectors is run through a pluggable
// `PlaneAdapter`. Story 3.1 ships the vectors, the harness, and an in-process REFERENCE
// off-chain adapter. Story 3.4 supplies the real off-chain adapter (DB `flow_permissions`);
// Epic 4 supplies the on-chain adapter. The SAME vectors run against all planes so the two
// rule sets cannot silently diverge (FR-19, NFR-8).
import type {
  AccountTypeCode,
  AssetKind,
  Classification,
  DestinationKind,
  Effect,
} from '../spec/rule-spec-schema.js';

/** The planes a vector is asserted against. */
export type Plane = 'OFF_CHAIN' | 'ON_CHAIN';

/** A single capital-movement scenario under evaluation. */
export interface TransferScenario {
  readonly from: AccountTypeCode;
  readonly classification: Classification;
  readonly to: DestinationKind;
  readonly assetKind: AssetKind;
  /** True if the flow is routed through a VCC account (token/trading flows must not). */
  readonly throughVcc?: boolean;
}

/**
 * Runtime environment a plane needs to decide floor-guarded flows. The actual floor value is a
 * config/parked param (Story 3.4); here it is modeled abstractly so no money arithmetic (and no
 * float — NFR-2) happens in the conformance layer:
 *  - `backingFloatFloor` undefined ⇒ floor config is ABSENT ⇒ a floor-guarded flow is REFUSED.
 *  - `postBalanceBelowFloor` true ⇒ the flow would draw the account below its floor ⇒ DENY.
 */
export interface ConformanceEnv {
  readonly backingFloatFloor?: bigint;
  readonly postBalanceBelowFloor?: boolean;
}

/** A conformance vector: a scenario + environment + the expected decision, tagged per-plane. */
export interface ConformanceVector {
  readonly id: string;
  readonly description: string;
  readonly scenario: TransferScenario;
  readonly env: ConformanceEnv;
  readonly expected: Effect;
  readonly planes: readonly Plane[];
}

/** A plane under test: names which plane it is and evaluates a scenario to an {@link Effect}. */
export interface PlaneAdapter {
  readonly name: string;
  readonly plane: Plane;
  evaluate(scenario: TransferScenario, env: ConformanceEnv): Effect;
}

/** One vector's outcome against an adapter. */
export interface ConformanceResult {
  readonly vector: ConformanceVector;
  readonly actual: Effect;
  readonly passed: boolean;
}
