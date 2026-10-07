import type {
  ComplianceRefusalCode,
  ConsentBasis,
  PreferenceResult,
  SuppressionScope,
  SuppressionSource,
  WorkspaceCompliance,
} from '@winsendotai/ovo-contracts';
import type { CompliancePolicy } from './policy.ts';
import type { CliSeries, RulePack } from './rule-packs.ts';

/**
 * The one dial-path evaluator (compliance spec 3.5): a pure function of the effective policy, the
 * recipient's facts and `now`. Every stage (create, admit, authorize, manual, redrive) loads the
 * facts and calls it, so a call is judged the same way wherever it is checked.
 */
export interface ConsentFact {
  id: string;
  basis: ConsentBasis;
  category: string;
  principalEntity: string;
  purpose: string;
  obtainedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}

export interface LedgerFact {
  authorizedAt: Date;
  connected: boolean;
  outcome?: string;
  category?: string;
}

export interface RecipientFacts {
  suppression?: { source: SuppressionSource; scope: SuppressionScope; purpose?: string };
  openComplaint: boolean;
  consents: ConsentFact[];
  preference?: { result: PreferenceResult; checkedAt: Date; provider: string; ref?: string };
  /** This number's authorized attempts over the last 30 days, newest first. */
  ledger: LedgerFact[];
  cli?: { series: CliSeries; categories: string[]; status: string };
  a2pDeclared: boolean;
  /** When the caller number's hourly or daily velocity limit next frees a slot. */
  cliBlockedUntil?: Date;
  breakerTripped: boolean;
}

export interface EvaluationInput {
  pack: RulePack;
  settings: WorkspaceCompliance;
  policy: CompliancePolicy;
  recipient: string;
  facts: RecipientFacts;
  now: Date;
  /** A manual call already judged at request time is not re-judged against the window. */
  skipWindow?: boolean;
}

export interface Verdict {
  verdict: 'allow' | 'refuse' | 'defer';
  reason?: ComplianceRefusalCode;
  details?: Record<string, unknown>;
  nextEligibleAt?: Date;
  warnings: ComplianceRefusalCode[];
  consentId?: string;
  preferenceRef?: string;
  bypass?: 'test_number';
  /** A test number judged without its per-recipient caps (`enforcement.testNumberCaps`). */
  capsExempt?: true;
}

export class Refusal {
  constructor(
    readonly reason: ComplianceRefusalCode,
    readonly details?: Record<string, unknown>,
  ) {}
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
