import type { ComplianceRefusalCode, ConsentBasis } from '@winsendotai/ovo-contracts';
import { HOUR, Refusal, type EvaluationInput, type Verdict } from './evaluate-types.ts';
import { consentBasisFor } from './policy.ts';

/** The consent this call relies on, or the reason it has none (R9-R13). */
function consentFor(input: EvaluationInput): { id?: string; refusal?: Refusal } {
  const { policy, facts, now, pack } = input;
  const basis = consentBasisFor(policy);
  if (!basis || !pack.categories![policy.category!].consent.includes(basis))
    return { refusal: new Refusal('consent_basis_not_allowed', { basis: basis ?? null }) };
  if (basis === 'preference_allows') return {};
  const accepts = (candidate: ConsentBasis) =>
    candidate === basis ||
    (basis === 'explicit_registered' && candidate === 'explicit_legacy_registered');
  const rows = facts.consents.filter(
    (row) =>
      row.category === policy.category && (basis === 'inferred_relationship' || accepts(row.basis)),
  );
  const scope = policy.consentScope;
  const scoped = rows.filter(
    (row) =>
      (!scope?.principalEntity || row.principalEntity === scope.principalEntity) &&
      (!scope?.purpose || row.purpose === scope.purpose),
  );
  const active = scoped.find(
    (row) => !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > now.getTime()),
  );
  if (active) return { id: active.id };
  // An inferred relationship needs no row, unless the customer revoked the one on record.
  if (basis === 'inferred_relationship')
    return scoped.some((row) => row.revokedAt) ? { refusal: new Refusal('consent_revoked') } : {};
  if (!rows.length) return { refusal: new Refusal('no_consent', { basis }) };
  if (!scoped.length) return { refusal: new Refusal('consent_scope_mismatch', { basis }) };
  return {
    refusal: new Refusal(
      scoped.some((row) => !row.revokedAt) ? 'consent_expired' : 'consent_revoked',
    ),
  };
}

function preferenceRefusal(input: EvaluationInput, consented: boolean): Refusal | undefined {
  const { policy, facts, settings, now } = input;
  const preference = facts.preference;
  const basis = consentBasisFor(policy);
  if (policy.category === 'service' && basis === 'explicit_service_7d')
    // R14: FULLY BLOCK also blocks service calls that need explicit consent, unless consented.
    return preference?.result === 'fully_blocked' && !consented
      ? new Refusal('preference_blocked')
      : undefined;
  if (policy.category !== 'promotional' || consented) return undefined;
  const maxAge = Math.min(settings.scrub.maxAgeHours, policy.scrubMaxAgeHours ?? Infinity);
  if (!preference || now.getTime() - preference.checkedAt.getTime() > maxAge * HOUR)
    return new Refusal('preference_unverified');
  if (preference.result === 'unknown') return new Refusal('preference_unverified');
  if (preference.result !== 'allowed') return new Refusal('preference_blocked');
  return undefined;
}

function seriesProblem(input: EvaluationInput): ComplianceRefusalCode | undefined {
  const { facts, policy, pack, settings } = input;
  const cli = facts.cli;
  if (!cli) return 'from_number_not_registered';
  const category = policy.category!;
  // A regulated sender's service and transactional calls must come from its sector's series (R3).
  const sector = pack.sectorSeries[settings.sender.regulator];
  if (category !== 'promotional' && sector && cli.series !== sector)
    return 'series_regulator_mismatch';
  if (!pack.categories![category].series.includes(cli.series) || !cli.categories.includes(category))
    return 'series_category_mismatch';
  return undefined;
}

/** The registration checks a test number skips: category, CLI series, A2P, consent and DND. */
export function registrationChecks(input: EvaluationInput, verdict: Verdict): void {
  const { pack, policy, settings, facts, now } = input;
  if (!policy.category) throw new Refusal('category_missing');
  const series = seriesProblem(input);
  if (series && settings.enforcement.series === 'warn') verdict.warnings.push(series);
  else if (series) throw new Refusal(series);
  const required = [
    settings.enforcement.a2pDeclarationRequiredFrom,
    pack.a2pDeclarationRequiredFrom,
  ]
    .filter((date): date is string => !!date)
    .sort()[0];
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  if (required && today >= required) {
    if (!facts.a2pDeclared) throw new Refusal('a2p_not_declared', { requiredFrom: required });
  } else if (!settings.autodialerIntimation) throw new Refusal('autodialer_intimation_missing');
  const consent = consentFor(input);
  const preference = preferenceRefusal(input, !!consent.id);
  if (preference && (!consent.refusal || preference.reason === 'preference_blocked'))
    throw preference;
  if (consent.refusal) throw consent.refusal;
  if (consent.id) verdict.consentId = consent.id;
  if (facts.preference?.ref) verdict.preferenceRef = facts.preference.ref;
}
