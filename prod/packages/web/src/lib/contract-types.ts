// The wire-contract types the surfaces consume — the SINGLE SOURCE is `@rose/api`'s Zod schemas
// (`import type` ⇒ fully erased under verbatimModuleSyntax: no runtime edge, no Fastify in the
// browser bundle). Nested shapes are reached by indexed access so nothing is redefined here.
import type {
  CoupledPairResponse,
  GroupViewResponse,
  RedeemRequest,
  RedemptionResponse,
  RoseNoteResponse,
  SubscribeRequest,
  SubscriptionResponse,
} from '@rose/api';

export type {
  CoupledPairResponse,
  GroupViewResponse,
  RedeemRequest,
  RedemptionResponse,
  RoseNoteResponse,
  SubscribeRequest,
  SubscriptionResponse,
};

/** A monetary amount over the wire (NFR-2): every value a string, `scale` metadata. */
export type Money = GroupViewResponse['consolidated'][number]['nav'];

/** A per-entity block in the group view (entity code, accounts, by-asset subtotals). */
export type GroupViewEntity = GroupViewResponse['entities'][number];

/** A single account balance row within an entity. */
export type AccountBalance = GroupViewEntity['accounts'][number];

/** A coupled-pair position as carried in the group view. */
export type CoupledPairPosition = GroupViewResponse['coupledPairs'][number];

/** The consolidated per-asset NAV subtotal. */
export type ConsolidatedAsset = GroupViewResponse['consolidated'][number];

/** The ledger↔chain comparison block (the divergence signal, FR-10). */
export type ChainComparison = GroupViewResponse['chainComparison'];

/** A single per-asset ledger↔chain divergence row. */
export type Divergence = ChainComparison['divergences'][number];

/** The six fixed coupled-pair lifecycle states (FR-4). */
export type CoupledPairState = CoupledPairPosition['state'];

/** The four fixed entity codes. */
export type EntityCode = GroupViewEntity['entityCode'];
