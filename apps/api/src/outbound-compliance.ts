import {
  callingWindowState,
  CompliancePolicyError,
  releaseCallingWindow,
  resolveCallingWindow,
  validateReleaseVariables,
  type CallingWindow,
  type CallingWindowInput,
  type CampaignContactInput,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

export interface ComplianceRefusal {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

type Checked<T> = { ok: true; value: T } | ({ ok: false } & ComplianceRefusal);

/**
 * The calling window a campaign or call snapshots: the campaign's own, judged in its schedule
 * timezone unless it names one, else the release's (`compliance.callingHours`, in the agent's
 * timezone). Null places calls at any hour, which is how a release without the block behaves.
 */
export function campaignCallingWindow(
  release: Pick<ReleaseRecord, 'config'>,
  override: CallingWindowInput | undefined,
  scheduleTimezone: string,
): Checked<CallingWindow | null> {
  try {
    if (override) return { ok: true, value: resolveCallingWindow(override, scheduleTimezone) };
    return { ok: true, value: releaseCallingWindow(release.config) ?? null };
  } catch (error) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_calling_window',
      message:
        error instanceof CompliancePolicyError
          ? error.message
          : 'Calling window timezone is invalid',
    };
  }
}

/**
 * The checks a manual dial (the console's live and test calls) runs before anything is queued:
 * the number is not on the do-not-call list, and the release's calling hours are open now.
 */
export async function manualDialCompliance(
  operations: OperationsService,
  release: Pick<ReleaseRecord, 'config'>,
  to: string,
  now = new Date(),
): Promise<Checked<CallingWindow | null>> {
  if ((await operations.campaigns.doNotCall.listed([to])).size)
    return {
      ok: false,
      status: 409,
      code: 'do_not_call',
      message: 'This number is on the do-not-call list',
    };
  const window = campaignCallingWindow(release, undefined, 'UTC');
  if (!window.ok || !window.value) return window;
  const state = callingWindowState(window.value, now);
  if (!state.open)
    return {
      ok: false,
      status: 409,
      code: 'outside_calling_hours',
      message: `Calls to this agent are allowed ${window.value.start}-${window.value.end} ${window.value.timezone}`,
      details: { nextOpenAt: state.nextOpenAt.toISOString(), callingWindow: window.value },
    };
  return window;
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
