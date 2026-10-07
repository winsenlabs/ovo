import type { CompatIssue, ReleaseSelections } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import { validateSelections, type SessionDefaults } from '@winsendotai/ovo-session-host';
import { costAdmissionIssues, type CostAdmissionLedger } from './cost-admission-readiness.ts';

interface LiveResult {
  liveReady: boolean;
  liveBlockers: string[];
  details: CompatIssue[];
}

/**
 * Folds the latest release into the draft's live readiness. Admission prices the release a job
 * routes to (worker cost-runtime `reserve` reads the job's release), not the draft, so a draft
 * fixed after the release was cut still leaves every call refused until it is published again.
 * The release is checked for drifted plugin pins and for what cost admission refuses. A problem
 * the draft already reports is not repeated; the rest name the release.
 */
export async function withLatestRelease<T extends LiveResult>(
  live: T,
  input: {
    release?: Pick<ReleaseRecord, 'id' | 'config' | 'selections' | 'providerBindings'>;
    registry: PluginRegistry;
    defaults?: SessionDefaults;
    ledger?: CostAdmissionLedger;
  },
): Promise<T> {
  const { release } = input;
  if (!release) return live;
  const pins = validateSelections(
    {
      config: release.config,
      selections: release.selections,
      registry: input.registry,
      defaults: input.defaults,
      legacyProviderBindings: release.providerBindings,
    },
    'live',
  ).filter(
    (issue) =>
      issue.code === 'plugin_version_not_installed' || issue.code === 'legacy_release_unpinned',
  );
  const cost: CompatIssue[] = release.config.costPolicy
    ? await costAdmissionIssues({
        config: release.config,
        // A legacy release without selections is reported unpinned above.
        selections: (release.selections ?? {}) as ReleaseSelections,
        registry: input.registry,
        ledger: input.ledger,
      })
    : [
        {
          code: 'meter_uncovered',
          severity: 'error',
          stage: 'live',
          message: 'A live-call budget and maximum duration policy are required.',
          field: 'costPolicy',
        },
      ];
  const reported = new Set(live.details.map((issue) => issue.message));
  const uncovered = new Set(
    live.details.filter((issue) => issue.code === 'meter_uncovered').map((issue) => issue.field),
  );
  const named = cost
    .filter(
      (issue) =>
        !reported.has(issue.message) &&
        !(issue.message.startsWith('Cost meter is not configured') && uncovered.has(issue.field)),
    )
    .map((issue) => ({ ...issue, message: `Latest release ${release.id}: ${issue.message}` }));
  const issues = [...pins, ...named];
  const blockers = issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  return {
    ...live,
    liveReady: live.liveReady && blockers.length === 0,
    liveBlockers: [...new Set([...live.liveBlockers, ...blockers])],
    details: [...live.details, ...issues],
  };
}
