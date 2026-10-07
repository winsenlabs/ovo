import {
  CompliancePolicyError,
  callingWindowSchema,
  normalizePhoneNumber,
  releaseCallingWindow,
  resolveCallingWindow,
  validateReleaseVariables,
  type CallingWindow,
  type CallingWindowInput,
  type CampaignContactInput,
  type CompliancePolicy,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import {
  CampaignCompliance,
  complianceRefusal,
  type ComplianceRefusalCode,
} from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

export interface ComplianceRefusal {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

type Checked<T> = { ok: true; value: T } | ({ ok: false } & ComplianceRefusal);

function invalidWindow(error: unknown): ComplianceRefusal {
  return {
    status: 422,
    code: 'invalid_calling_window',
    message:
      error instanceof CompliancePolicyError ? error.message : 'Calling window timezone is invalid',
  };
}

/**
 * The compliance policy a campaign or call snapshots: the agent's category, purpose and calling
 * hours (read structurally from the immutable release) and the campaign's own window and block.
 * The campaign window narrows the agent's, never replaces it (G4); +91 numbers are judged in IST.
 */
export function campaignPolicy(
  release: Pick<ReleaseRecord, 'config'>,
  input: {
    callingWindow?: CallingWindowInput;
    compliance?: CampaignCompliance;
    scheduleTimezone: string;
    manual?: boolean;
  },
): Checked<{ policy: CompliancePolicy; campaignWindow: CallingWindow | null }> {
  const config = (release.config ?? {}) as {
    timezone?: string;
    compliance?: { category?: string; purpose?: string };
  };
  let agentWindow: CallingWindow | undefined;
  let campaignWindow: CallingWindow | undefined;
  try {
    agentWindow = releaseCallingWindow(release.config);
    if (input.callingWindow)
      campaignWindow = resolveCallingWindow(
        callingWindowSchema.parse(input.callingWindow),
        input.scheduleTimezone,
      );
  } catch (error) {
    return { ok: false, ...invalidWindow(error) };
  }
  const asRules = (window: CallingWindow) => ({
    rules: [
      { start: window.start, end: window.end, ...(window.days ? { days: window.days } : {}) },
    ],
    timezone: window.timezone,
  });
  const block = CampaignCompliance.parse(input.compliance ?? {});
  const policy: CompliancePolicy = {
    version: 1,
    ...(config.compliance?.category
      ? { category: config.compliance.category as CompliancePolicy['category'] }
      : {}),
    ...(config.compliance?.purpose
      ? { purpose: config.compliance.purpose as CompliancePolicy['purpose'] }
      : {}),
    ...(agentWindow ? { agentWindow: asRules(agentWindow) } : {}),
    ...(campaignWindow ? { campaignWindow: asRules(campaignWindow) } : {}),
    ...block,
    ...(input.manual ? { manual: true } : {}),
  };
  return { ok: true, value: { policy, campaignWindow: campaignWindow ?? null } };
}

/** A refused or deferred verdict as the API's error body. */
export function refusalFor(
  reason: ComplianceRefusalCode,
  details?: Record<string, unknown>,
): ComplianceRefusal {
  return { ...complianceRefusal(reason), code: reason, ...(details ? { details } : {}) };
}

/**
 * The checks a manual dial (the console's live and test calls) runs before anything is queued
 * (stage E5): the do-not-call list, then the full compliance evaluator, the window included.
 */
export async function manualDialCompliance(
  operations: OperationsService,
  release: Pick<ReleaseRecord, 'config'>,
  to: string,
  fromNumber: string,
  now = new Date(),
): Promise<Checked<{ window: CallingWindow | null; policy: CompliancePolicy }>> {
  if ((await operations.campaigns.doNotCall.listed([to])).size)
    return {
      ok: false,
      status: 409,
      code: 'do_not_call',
      message: 'This number is on the do-not-call list',
    };
  const resolved = campaignPolicy(release, { scheduleTimezone: 'UTC', manual: true });
  if (!resolved.ok) return resolved;
  const window = releaseCallingWindow(release.config) ?? null;
  const verdict = await operations.compliance.checkManual({
    phoneNumber: normalizePhoneNumber(to),
    fromNumber,
    policy: resolved.value.policy,
    now,
  });
  if (verdict.verdict === 'allow')
    return { ok: true, value: { window, policy: resolved.value.policy } };
  const reason = verdict.reason!;
  if (reason === 'outside_calling_hours')
    return {
      ok: false,
      status: 409,
      code: reason,
      message: window
        ? `Calls to this agent are allowed ${window.start}-${window.end} ${window.timezone}`
        : 'Outside the effective calling window',
      details: { nextOpenAt: verdict.nextEligibleAt?.toISOString(), callingWindow: window },
    };
  return {
    ok: false,
    ...refusalFor(reason, {
      ...(verdict.details ?? {}),
      ...(verdict.nextEligibleAt ? { nextEligibleAt: verdict.nextEligibleAt.toISOString() } : {}),
    }),
  };
}

/**
 * Stage E1 at campaign create: the policy's own problems (category, consent basis, windows that
 * widen a floor), then each contact as the gate would judge it now. A refusal about the sender
 * (CLI series, A2P, autodialler intimation) refuses the campaign; the rest is an import report.
 */
export async function campaignCompliance(
  operations: OperationsService,
  policy: CompliancePolicy,
  fromNumber: string,
  contacts: readonly Pick<CampaignContactInput, 'phoneNumber'>[],
): Promise<Checked<Record<string, number>>> {
  const recipients = contacts.map((contact) => normalizePhoneNumber(contact.phoneNumber));
  const problems = await operations.compliance.problems(policy, recipients);
  if (problems.length)
    return {
      ok: false,
      ...refusalFor(problems[0]!.code),
      message: problems[0]!.message,
      details: { problems },
    };
  const report: Record<string, number> = {};
  for (const verdict of await operations.compliance.preview(policy, fromNumber, recipients)) {
    const key = verdict.reason ?? verdict.verdict;
    report[key] = (report[key] ?? 0) + 1;
    if (verdict.reason && operations.compliance.pausesCampaign(verdict.reason))
      return { ok: false, ...refusalFor(verdict.reason) };
  }
  return { ok: true, value: report };
}

/**
 * Import-time check of each contact's variables against the release's declared schema (Wave 2
 * deferred #7b). Errors name fields and rules only, never values.
 */
export function contactVariableErrors(
  release: Pick<ReleaseRecord, 'config'>,
  contacts: readonly Pick<CampaignContactInput, 'sourceRow' | 'variables'>[],
): { row: number; errors: string[] }[] {
  return contacts.flatMap((contact) => {
    const result = validateReleaseVariables(release.config.variables, contact.variables);
    return result.valid ? [] : [{ row: contact.sourceRow, errors: result.errors }];
  });
}
