/**
 * Whether a do-not-call entry `s` stops a contact `c` of campaign `k`: an entry for every call
 * always does, a promotional-only one stops promotional campaigns, a purpose one stops campaigns
 * with that purpose. A campaign without a category is stopped by any entry, as before scopes.
 */
export const SUPPRESSION_APPLIES = `(s.scope = 'all' OR k.category IS NULL
  OR (s.scope = 'promotional' AND k.category = 'promotional')
  OR (s.scope = 'purpose' AND (s.purpose IS NULL OR s.purpose = COALESCE(k.purpose, 'other'))))`;

/** What a refusal does to the contact: requeue it, end it, or pause the whole campaign. */
export type RefusalEffect = 'suppressed' | 'invalid' | 'pause';

const PAUSES = new Set([
  'category_missing',
  'from_number_not_registered',
  'series_category_mismatch',
  'series_regulator_mismatch',
  'a2p_not_declared',
  'autodialer_intimation_missing',
  'cli_suspended',
  'cli_flagged',
  'calling_window_empty',
  'consent_basis_not_allowed',
  'abandoned_ratio_breaker',
]);
const SUPPRESSES = new Set([
  'suppressed',
  'opt_out_locked',
  'complaint_open',
  'preference_blocked',
]);

/**
 * A refusal about the sender (category, CLI, A2P, breaker) pauses the campaign until the operator
 * fixes it; one about the recipient ends that contact as `suppressed` or `invalid`.
 */
export function refusalEffect(reason: string): RefusalEffect {
  if (PAUSES.has(reason)) return 'pause';
  return SUPPRESSES.has(reason) ? 'suppressed' : 'invalid';
}
