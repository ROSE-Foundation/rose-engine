import type { ReactNode } from 'react';

/** The Subscriber's ONCHAINID eligibility (FR-19) — an injected session/prop input in paper/local. */
export interface Eligibility {
  eligible: boolean;
  reason?: string;
}

const DEFAULT_REASON =
  'Subscription unavailable — eligibility claim not found. Contact your administrator.';

/**
 * The eligibility gate (UX-DR6, FR-19, PRD §5). When the Subscriber carries a valid ONCHAINID claim
 * the subscribe path (children) is rendered; otherwise it is **unavailable with an explicit named
 * reason** — never a generic block screen, and never a self-service KYC flow.
 */
export function EligibilityGate({
  eligibility,
  children,
}: {
  eligibility: Eligibility;
  children: ReactNode;
}): React.JSX.Element {
  if (eligibility.eligible) return <>{children}</>;
  return (
    <p role="status" className="rounded-md border border-warn p-4 text-warn">
      {eligibility.reason ?? DEFAULT_REASON}
    </p>
  );
}
