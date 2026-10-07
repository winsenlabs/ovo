/**
 * A DND / NCPR preference scrub (TCCCPR Schedule II, R14). The sender cannot query the NCPR
 * directly: results come from its telemarketer's or telco's portal, either uploaded by hand
 * (`manual-upload`, built in) or fetched by a vendor plugin. Promotional calls fail closed on an
 * `unknown` or stale result (R9).
 */
export type PreferenceResult = 'allowed' | 'blocked' | 'fully_blocked' | 'unknown';

export interface PreferenceCheck {
  phoneNumber: string;
  result: PreferenceResult;
  /** NCPR content categories 1-8 the number blocks (1 = banking, insurance, financial products). */
  blockedCategories?: number[];
  blockedTimeBands?: number[];
  blockedDayTypes?: number[];
  /** The provider's reference for the check, kept as evidence. */
  ref?: string;
}

export interface PreferenceProvider {
  /** `manual-upload`, `rtm-<vendor>` or `oap-<telco>`. */
  readonly id: string;
  /** How long a result stays valid; telcos apply DND changes within 24 hours (TCCCPR 2018). */
  readonly maxAgeHours: number;
  check(
    numbers: readonly string[],
    context: { category: 'promotional' | 'service'; contentCategory?: number },
  ): Promise<PreferenceCheck[]>;
}
