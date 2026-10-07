/**
 * Why the dial path refused or deferred a call (compliance spec 3.6). 422 marks a configuration
 * the operator must fix; 409 marks the recipient's or the number's current state. The message is
 * the console's text and never names the phone number.
 */
export const COMPLIANCE_REFUSALS = {
  category_missing: [422, 'The agent has no call category (promotional, service or transactional)'],
  from_number_not_registered: [422, 'The caller number is not in the CLI registry'],
  series_category_mismatch: [422, 'The caller number series is not allowed for this call category'],
  series_regulator_mismatch: [
    422,
    "The caller number series does not match the sender's regulator",
  ],
  a2p_not_declared: [422, 'The caller number has no effective A2P declaration'],
  autodialer_intimation_missing: [422, 'No autodialler intimation to the telco is on file'],
  cli_suspended: [409, 'The caller number is suspended'],
  cli_flagged: [409, 'The caller number was flagged by the telco'],
  calling_window_empty: [422, 'The effective calling window never opens'],
  policy_widens_floor: [422, 'A calling window is wider than the window it must stay inside'],
  consent_basis_not_allowed: [422, 'This consent basis is not allowed for the call category'],
  scrub_provider_missing: [422, 'Promotional calls need a preference (DND) scrub provider'],
  outside_calling_hours: [409, 'Outside the effective calling window'],
  suppressed: [409, 'The number is on the do-not-call list'],
  opt_out_locked: [409, 'The number opted out less than 90 days ago'],
  complaint_open: [409, 'The number has an open complaint'],
  no_consent: [409, 'No consent on record for this call'],
  consent_expired: [409, 'The consent for this call has expired'],
  consent_revoked: [409, 'The consent for this call was revoked'],
  consent_scope_mismatch: [409, 'The consent on record covers another brand or purpose'],
  preference_blocked: [409, 'The number blocks this category in the DND register'],
  preference_unverified: [409, 'No fresh DND scrub result for this number'],
  recipient_attempt_cap: [409, 'The number has had its allowed attempts'],
  recipient_connected_cap: [409, 'The number has had its allowed conversations'],
  min_gap: [409, 'Too soon after the last call to this number'],
  refusal_cooloff: [409, 'The number declined recently'],
  outcome_no_retry: [409, 'The last outcome forbids calling again'],
  cli_velocity_limit: [409, 'The caller number reached its hourly or daily limit'],
  abandoned_ratio_breaker: [
    409,
    'Abandoned or silent calls on this caller number crossed the limit',
  ],
} as const satisfies Record<string, readonly [409 | 422, string]>;

export type ComplianceRefusalCode = keyof typeof COMPLIANCE_REFUSALS;

/** The HTTP status and console text for a refusal code. */
export function complianceRefusal(code: ComplianceRefusalCode): {
  status: 409 | 422;
  message: string;
} {
  const [status, message] = COMPLIANCE_REFUSALS[code];
  return { status, message };
}
