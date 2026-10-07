import type { ComplianceRefusalCode } from '@winsendotai/ovo-contracts';
import {
  DAY,
  Refusal,
  type EvaluationInput,
  type RecipientFacts,
  type Verdict,
} from './evaluate-types.ts';
import { resolveCaps, windowLayers, type CompliancePolicy } from './policy.ts';
import { registrationChecks } from './registration.ts';
import { layersState } from './windows.ts';

export type * from './evaluate-types.ts';

function suppressionApplies(
  suppression: NonNullable<RecipientFacts['suppression']>,
  policy: CompliancePolicy,
): boolean {
  if (suppression.scope === 'all' || !policy.category) return true;
  if (suppression.scope === 'promotional') return policy.category === 'promotional';
  return !suppression.purpose || suppression.purpose === (policy.purpose ?? 'other');
}

type Deferral = { reason: ComplianceRefusalCode; at: Date; details?: Record<string, unknown> };

function rollingDeferrals(input: EvaluationInput): Deferral[] {
  const { pack, settings, policy, facts, now } = input;
  const caps = resolveCaps(pack, settings, policy);
  const found: Deferral[] = [];
  const within = (ms: number, connected: boolean) =>
    facts.ledger.filter(
      (row) => now.getTime() - row.authorizedAt.getTime() < ms && (!connected || row.connected),
    );
  const check = (
    limit: number | undefined,
    ms: number,
    connected: boolean,
    reason: ComplianceRefusalCode,
    window: string,
  ) => {
    if (limit === undefined) return;
    const rows = within(ms, connected);
    if (limit === 0) throw new Refusal(reason, { window, limit });
    if (rows.length >= limit)
      found.push({
        reason,
        at: new Date(rows[limit - 1]!.authorizedAt.getTime() + ms),
        details: { window, limit },
      });
  };
  check(caps.attempts.per24h, DAY, false, 'recipient_attempt_cap', '24h');
  check(caps.attempts.per7d, 7 * DAY, false, 'recipient_attempt_cap', '7d');
  check(caps.attempts.per30d, 30 * DAY, false, 'recipient_attempt_cap', '30d');
  check(caps.connected.per24h, DAY, true, 'recipient_connected_cap', '24h');
  check(caps.connected.per7d, 7 * DAY, true, 'recipient_connected_cap', '7d');
  const last = facts.ledger[0];
  const gap = (caps.minGapMinutes ?? 0) * 60_000;
  if (last && gap && now.getTime() - last.authorizedAt.getTime() < gap)
    found.push({ reason: 'min_gap', at: new Date(last.authorizedAt.getTime() + gap) });
  const cooloff = settings.retry.refused?.cooloffDays ?? 30;
  const refused = facts.ledger.find(
    (row) => row.outcome === 'refused' && (!row.category || row.category === policy.category),
  );
  if (refused && cooloff && policy.category === 'promotional') {
    const until = refused.authorizedAt.getTime() + cooloff * DAY;
    if (until > now.getTime()) found.push({ reason: 'refusal_cooloff', at: new Date(until) });
  }
  if (pack.categories && facts.cliBlockedUntil && facts.cliBlockedUntil.getTime() > now.getTime())
    found.push({ reason: 'cli_velocity_limit', at: facts.cliBlockedUntil });
  return found;
}

export function evaluateDial(input: EvaluationInput): Verdict {
  const { pack, settings, policy, facts, recipient, now } = input;
  const verdict: Verdict = { verdict: 'allow', warnings: [] };
  try {
    if (facts.suppression && suppressionApplies(facts.suppression, policy))
      throw new Refusal('suppressed', {
        source: facts.suppression.source,
        scope: facts.suppression.scope,
      });
    if (facts.openComplaint) throw new Refusal('complaint_open');
    if (facts.cli?.status === 'flagged') throw new Refusal('cli_flagged');
    if (facts.cli && facts.cli.status !== 'active') throw new Refusal('cli_suspended');
    if (facts.breakerTripped) throw new Refusal('abandoned_ratio_breaker');
    if (pack.categories) {
      if (settings.testNumbers.includes(recipient)) verdict.bypass = 'test_number';
      else registrationChecks(input, verdict);
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { ...verdict, verdict: 'refuse', reason: error.reason, details: error.details };
  }
  let deferrals: Deferral[];
  try {
    deferrals = rollingDeferrals(input);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { ...verdict, verdict: 'refuse', reason: error.reason, details: error.details };
  }
  if (!input.skipWindow) {
    const state = layersState(windowLayers(pack, settings, policy), now);
    if (!state.open && 'never' in state)
      return { ...verdict, verdict: 'refuse', reason: 'calling_window_empty' };
    if (!state.open) deferrals.push({ reason: 'outside_calling_hours', at: state.nextOpenAt });
  }
  if (!deferrals.length) return verdict;
  const latest = deferrals.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
  return {
    ...verdict,
    verdict: 'defer',
    reason: latest.reason,
    nextEligibleAt: latest.at,
    ...(latest.details ? { details: latest.details } : {}),
  };
}
