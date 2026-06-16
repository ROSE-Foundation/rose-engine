// @rose/rule-spec — the shared conformance vectors (Story 3.1).
//
// This is the P0 baseline BOTH planes must satisfy (FR-8, UJ-3, NFR-4). Story 3.4 runs these
// against the off-chain provider; Epic 4 runs the SAME vectors against the on-chain compliance
// plane. Every vector is tagged for BOTH planes so neither can quietly drop coverage.
import type { ConformanceVector } from './types.js';

const BOTH = ['OFF_CHAIN', 'ON_CHAIN'] as const;

/** A representative non-zero floor used to model "floor config present" in env. */
const FLOOR_PRESENT = 1_000n;

export const conformanceVectors: readonly ConformanceVector[] = [
  {
    id: 'vec-fee-income-to-treasury-allow',
    description: 'FEE_INCOME (any entity) sweeping to treasury is allowed.',
    scenario: { from: 'FEE_INCOME', classification: 'NONE', to: 'TREASURY', assetKind: 'VALUE' },
    env: {},
    expected: 'ALLOW',
    planes: BOTH,
  },
  {
    id: 'vec-client-yield-to-treasury-allow',
    description: 'Yield earned on CLIENT_COLLATERAL may be swept to treasury (principal excluded).',
    scenario: {
      from: 'CLIENT_COLLATERAL',
      classification: 'YIELD',
      to: 'TREASURY',
      assetKind: 'VALUE',
    },
    env: {},
    expected: 'ALLOW',
    planes: BOTH,
  },
  {
    id: 'vec-client-principal-to-treasury-deny',
    description: 'Model-A: CLIENT_COLLATERAL principal may NOT be swept to treasury.',
    scenario: {
      from: 'CLIENT_COLLATERAL',
      classification: 'PRINCIPAL',
      to: 'TREASURY',
      assetKind: 'VALUE',
    },
    env: {},
    expected: 'DENY',
    planes: BOTH,
  },
  {
    id: 'vec-client-principal-to-external-deny',
    description: 'Model-A bright line: CLIENT_COLLATERAL principal may NOT leave to any external.',
    scenario: {
      from: 'CLIENT_COLLATERAL',
      classification: 'PRINCIPAL',
      to: 'EXTERNAL',
      assetKind: 'VALUE',
    },
    env: {},
    expected: 'DENY',
    planes: BOTH,
  },
  {
    id: 'vec-client-principal-within-client-allow',
    description: 'CLIENT_COLLATERAL principal may move WITHIN the client account.',
    scenario: {
      from: 'CLIENT_COLLATERAL',
      classification: 'PRINCIPAL',
      to: 'CLIENT_ACCOUNT',
      assetKind: 'VALUE',
    },
    env: {},
    expected: 'ALLOW',
    planes: BOTH,
  },
  {
    id: 'vec-backing-float-egress-above-floor-allow',
    description: 'BACKING_FLOAT egress is allowed when the post-balance stays at/above the floor.',
    scenario: { from: 'BACKING_FLOAT', classification: 'NONE', to: 'EXTERNAL', assetKind: 'VALUE' },
    env: { backingFloatFloor: FLOOR_PRESENT, postBalanceBelowFloor: false },
    expected: 'ALLOW',
    planes: BOTH,
  },
  {
    id: 'vec-backing-float-egress-below-floor-deny',
    description: 'BACKING_FLOAT egress that would push the balance below its floor is rejected.',
    scenario: { from: 'BACKING_FLOAT', classification: 'NONE', to: 'EXTERNAL', assetKind: 'VALUE' },
    env: { backingFloatFloor: FLOOR_PRESENT, postBalanceBelowFloor: true },
    expected: 'DENY',
    planes: BOTH,
  },
  {
    id: 'vec-backing-float-floor-absent-refuse',
    description:
      'BACKING_FLOAT egress with the floor config ABSENT is refused (never treated as 0).',
    scenario: { from: 'BACKING_FLOAT', classification: 'NONE', to: 'EXTERNAL', assetKind: 'VALUE' },
    env: {},
    expected: 'REFUSE',
    planes: BOTH,
  },
  {
    id: 'vec-uncovered-flow-default-deny',
    description: 'A transfer not covered by any rule is rejected by default (fail-closed).',
    scenario: {
      from: 'DEPLOYED_CAPITAL',
      classification: 'NONE',
      to: 'EXTERNAL',
      assetKind: 'VALUE',
    },
    env: {},
    expected: 'DENY',
    planes: BOTH,
  },
  {
    id: 'vec-token-flow-through-vcc-deny',
    description: 'Token/trading flows must not route through VCC accounts.',
    scenario: {
      from: 'FEE_INCOME',
      classification: 'NONE',
      to: 'TREASURY',
      assetKind: 'TOKEN',
      throughVcc: true,
    },
    env: {},
    expected: 'DENY',
    planes: BOTH,
  },
];
