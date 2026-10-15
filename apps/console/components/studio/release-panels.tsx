import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { InlineAlert, EmptyStateV2 } from '../ui/feedback-v2';
import { RelativeTime } from '../ui/display';
import type { AgentDraft, AgentReadiness, Release } from '../../lib/api';
import { ResponsiveTable } from '../primitives';
import { configurationDiff } from './release-diff';
import { humanisePluginId } from '../plugins/schema-field-helpers';

export function readinessIssueHref(agentId: string, slot: string): string {
  return `/agents/${encodeURIComponent(agentId)}/plugins#slot-${encodeURIComponent(slot)}`;
}

/**
 * The Configure tab's right rail: release readiness, the diff against the latest release, and
 * the release history (brief §3 "Release rail"). "Console composition" (the server-side
 * extension registry) and "Organization drafts" (a second copy of the Agents list) are gone —
 * neither told an operator anything about this agent.
 */
export function StudioRail({
  selected,
  releases,
  readiness,
  readinessError,
}: {
  selected: AgentDraft;
  releases: Release[];
  readiness?: AgentReadiness;
  readinessError?: string;
}) {
  // Newest first, as the API lists them (confirmed against the fixture).
  const latest = releases[0];
  const differences = latest ? configurationDiff(latest.config, selected.config) : [];
  return (
    <>
      <SectionCard
        title="Release readiness"
        actions={
          <StatusBadgeV2
            tone={readiness ? (readiness.releaseReady ? 'ok' : 'warn') : 'neutral'}
            label={readiness ? (readiness.releaseReady ? 'Ready' : 'Blocked') : 'Checking'}
          />
        }
      >
        <p className="muted">
          The readiness API validates this exact saved draft against secrets, capabilities, tools
          and its auto-derived plugin graph.
        </p>
        {readinessError && <InlineAlert tone="danger">{readinessError}</InlineAlert>}
        <ul className="check-list">
          <li>
            <span>{selected.config.name.trim() ? '✓' : '!'}</span> Identity present
          </li>
          <li>
            <span>{selected.config.processing.initial.trim() ? '✓' : '!'}</span> Initial processing
            phrase
          </li>
          <li>
            <span>
              {selected.config.mode === 'agent'
                ? selected.config.allowedTools.length
                  ? '✓'
                  : '!'
                : '—'}
            </span>{' '}
            Tool approvals{' '}
            {selected.config.mode === 'agent'
              ? `${selected.config.allowedTools.length} referenced`
              : 'not required by mode'}
          </li>
          <li>
            <span>{readiness?.releaseReady ? '✓' : '!'}</span>
            {readiness?.releaseReady
              ? 'Release validation passed'
              : 'Release validation not yet passing'}
          </li>
        </ul>
        {readiness?.blockers.length ? (
          <InlineAlert tone="danger">
            <strong>Blockers</strong>
            <ul>
              {readiness.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
        {readiness?.details?.length ? (
          <div className="ui-stack" aria-label="Compatibility details">
            {readiness.details.map((issue, index) => (
              <p key={`${issue.code}-${index}`}>
                <strong>
                  {issue.stage}
                  {issue.slot ? ` · ${issue.slot}` : ''}:
                </strong>{' '}
                {issue.slot ? (
                  <a href={readinessIssueHref(selected.id, issue.slot)}>{issue.message}</a>
                ) : (
                  issue.message
                )}
              </p>
            ))}
          </div>
        ) : null}
        {readiness?.requiredPluginIds.length ? (
          <ul className="plain-list">
            {readiness.requiredPluginIds.map((id) => (
              // A raw `@winsendotai/...` package id here (brief: never a raw id as the only
              // label) — this rail has no plugin catalog to resolve a `ui.label` from, so the
              // humanised fallback is the best available name; the id itself still shows as a
              // secondary, copyable reference.
              <li key={id}>
                <span>{humanisePluginId(id)}</span> <small className="mono muted">{id}</small>
              </li>
            ))}
          </ul>
        ) : null}
        <InlineAlert tone="warn">
          {readiness?.liveBlockers?.[0] ??
            'Live admission still requires current capacity, transport and provider checks.'}
        </InlineAlert>
      </SectionCard>
      <SectionCard
        title="Changes since release"
        actions={
          <StatusBadgeV2
            tone={differences.length ? 'neutral' : 'ok'}
            label={latest ? `${differences.length} changes` : 'First release'}
          />
        }
      >
        {!latest ? (
          <p className="muted">The first release will snapshot the complete saved configuration.</p>
        ) : !differences.length ? (
          <p className="muted">The draft matches the latest immutable release.</p>
        ) : (
          <ResponsiveTable label="Draft configuration changes">
            <thead>
              <tr>
                <th>Path</th>
                <th>Released</th>
                <th>Draft</th>
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
        {differences.length > 40 && (
          <small>
            {differences.length - 40} additional changes are omitted from this compact comparison.
          </small>
        )}
      </SectionCard>
      <SectionCard
        title="Immutable releases"
        actions={<StatusBadgeV2 tone="neutral" label={String(releases.length)} />}
      >
        {releases.length ? (
          <ol className="release-list">
            {releases.map((release, index) => (
              <li key={release.id}>
                <strong className="mono">{release.id}</strong>
                {index === 0 && <StatusBadgeV2 tone="ok" size="sm" label="Current" />}
                <small>
                  <RelativeTime value={release.createdAt} /> · {release.plugins?.length ?? 0} pinned
                  plugins
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyStateV2 variant="first-run" title="No published release">
            Publishing snapshots AgentConfig and a plugin lock. It does not mutate earlier releases.
          </EmptyStateV2>
        )}
      </SectionCard>
    </>
  );
}
