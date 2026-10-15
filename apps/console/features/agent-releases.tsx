'use client';
import { useEffect, useState } from 'react';
import { apiRequest, items, type Release } from '../lib/api';
import { formatPhoneNumber } from '../lib/format';
import { SubPageHeader } from '../components/studio/sub-page-header';
import { IdChip } from '../components/ui/section-card';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { ErrorState, EmptyStateV2, Skeleton } from '../components/ui/feedback-v2';
import { RelativeTime } from '../components/ui/display';
import { JsonViewer } from '../components/ui/code-block';
import { ResponsiveTable } from '../components/primitives';
import { configurationDiff } from '../components/studio/release-diff';
import { humanisePluginId } from '../components/plugins/schema-field-helpers';
import { RoutedSpeechClipStatus, loadRouted } from '../components/studio/speech-clip-status';

type ReleaseRow = Release & { current: boolean; liveOn: string[] };

function formatVia(via: string): string {
  return /^\+\d/.test(via) ? formatPhoneNumber(via) : via;
}

/** One release's expanded detail: its pinned plugin selections, a diff against the release right
 * before it, and the full config behind a collapsed raw-JSON viewer (brief §3 Releases: "row
 * expand with a slot table, Compare with previous, and JSON behind a collapsed viewer" — none of
 * which the plain summary table could show at all). */
function ReleaseDetail({ row, previous }: { row: ReleaseRow; previous?: Release }) {
  const selections = Object.entries(row.selections ?? {});
  const differences = previous ? configurationDiff(previous.config, row.config) : [];
  return (
    <div className="ui-stack ds-release-detail">
      <IdChip id={row.id} short={row.id} />
      <div>
        <h4>Pinned selections</h4>
        {selections.length ? (
          <ResponsiveTable label={`Pinned selections for release ${row.id}`}>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Plugin</th>
                <th>Version</th>
                <th>Binding</th>
              </tr>
            </thead>
            <tbody>
              {selections.map(
                ([slot, selection]) =>
                  selection && (
                    <tr key={slot}>
                      <td className="mono">{slot}</td>
                      <td>{humanisePluginId(selection.pluginId)}</td>
                      <td className="mono">{selection.version}</td>
                      <td>
                        {selection.binding?.provider ?? (
                          <span className="ds-unknown">Environment binding</span>
                        )}
                      </td>
                    </tr>
                  ),
              )}
            </tbody>
          </ResponsiveTable>
        ) : (
          <p className="muted">
            No selections were recorded for this release (made before pinned selections existed).
          </p>
        )}
      </div>
      <div>
        <h4>Compare with previous</h4>
        {!previous ? (
          <p className="muted">This is the first release; there is nothing earlier to compare.</p>
        ) : !differences.length ? (
          <p className="muted">Identical configuration to the previous release.</p>
        ) : (
          <ResponsiveTable label={`Changes from the release before ${row.id}`}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Previous</th>
                <th>This release</th>
              </tr>
            </thead>
            <tbody>
              {differences.slice(0, 40).map((difference) => (
                <tr key={difference.path}>
                  <td className="mono">{difference.path}</td>
                  <td className="compact-json">{JSON.stringify(difference.before)}</td>
                  <td className="compact-json">{JSON.stringify(difference.after)}</td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </div>
      <JsonViewer value={row.config} label="Show full configuration" filename={`${row.id}.json`} />
    </div>
  );
}

export function AgentReleasesFeature({ agentId }: { agentId: string }) {
  const [releases, setReleases] = useState<Release[]>();
  const [liveOn, setLiveOn] = useState<Map<string, string[]>>(new Map());
  const [error, setError] = useState<string>();

  const load = () => {
    setError(undefined);
    void apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`)
      .then(({ data }) => setReleases(items(data)))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Releases unavailable'),
      );
    void loadRouted().then(setLiveOn, () => setLiveOn(new Map()));
  };
  useEffect(load, [agentId]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!releases)
    return (
      <div className="ui-stack">
        <Skeleton shape="block" />
      </div>
    );

  // Newest first, as the API lists them (confirmed against the fixture); the newest (and only
  // the newest) is "Current".
  const rows: ReleaseRow[] = releases.map((release, index) => ({
    ...release,
    current: index === 0,
    liveOn: liveOn.get(release.id) ?? [],
  }));

  return (
    <div className="ui-stack">
      <SubPageHeader
        title="Releases"
        description="Immutable published configurations, newest first, and what currently routes to each."
      />
      {/* `releases` comes back newest first; `RoutedSpeechClipStatus` wants the opposite. */}
      <RoutedSpeechClipStatus agentId={agentId} releases={[...releases].reverse()} />
      {rows.length ? (
        <ul className="ds-release-rows">
          {rows.map((row, index) => (
            <li key={row.id}>
              <details>
                <summary>
                  <span className="ui-cluster">
                    {/* Plain text here: a <summary> is itself the control, so the IdChip's copy
                        button nested inside it failed axe `nested-interactive`. The copyable
                        chip lives in the expanded detail instead. */}
                    <span className="mono ds-id-text" title={row.id}>
                      {row.id.slice(0, 12)}
                    </span>
                    {row.current && <StatusBadgeV2 tone="ok" size="sm" label="Current" />}
                  </span>
                  <span className="muted">
                    <RelativeTime value={row.createdAt} />
                  </span>
                  <span className="muted">{row.plugins?.length ?? 0} plugins</span>
                  <span className="ui-cluster">
                    {row.liveOn.length ? (
                      row.liveOn.map((via) => (
                        <span className="ds-chip" key={via}>
                          {formatVia(via)}
                        </span>
                      ))
                    ) : (
                      <span className="ds-unknown">Not routed</span>
                    )}
                  </span>
                </summary>
                <ReleaseDetail row={row} previous={releases[index + 1]} />
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyStateV2 variant="first-run" title="No releases yet" />
      )}
    </div>
  );
}
