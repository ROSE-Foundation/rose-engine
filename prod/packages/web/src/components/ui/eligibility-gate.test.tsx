// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EligibilityGate } from './eligibility-gate.js';

describe('EligibilityGate (UX-DR6, FR-19)', () => {
  it('renders the subscribe path when the Subscriber is eligible', () => {
    render(
      <EligibilityGate eligibility={{ eligible: true }}>
        <button type="button">Subscribe</button>
      </EligibilityGate>,
    );
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument();
  });

  it('hides the subscribe path and states an explicit named reason when ineligible', () => {
    render(
      <EligibilityGate eligibility={{ eligible: false }}>
        <button type="button">Subscribe</button>
      </EligibilityGate>,
    );
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
    // Explicit reason, not a generic block, no self-service KYC.
    expect(screen.getByText(/eligibility claim not found/i)).toBeInTheDocument();
    expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
  });

  it('surfaces a custom reason when provided', () => {
    render(
      <EligibilityGate eligibility={{ eligible: false, reason: 'Eligibility claim expired.' }}>
        <button type="button">Subscribe</button>
      </EligibilityGate>,
    );
    expect(screen.getByText(/eligibility claim expired/i)).toBeInTheDocument();
  });
});
