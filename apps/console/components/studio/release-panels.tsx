import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { AgentDraft, AgentReadiness, Release } from '../../lib/api';
import {
  EmptyState,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { configurationDiff } from './release-diff';
export function StudioRail({
  selected,
  releases,
  extensions,
  readiness,
  readinessError,
}: {
  selected: AgentDraft;
  releases: Release[];
  extensions: readonly ConsoleExtension[];
  readiness?: AgentReadiness;
  readinessError?: string;
}) {
  const latest = releases[0];
  const differences = latest ? configurationDiff(latest.config, selected.config) : [];
  return (
    <aside className="studio-rail" aria-label="Release readiness">
      <Panel labelledBy="readiness-title">
        <PanelHeader
          id="readiness-title"
          title="Release readiness"
          badge={
            <StatusBadge tone={readiness?.releaseReady ? 'good' : 'warning'}>
              {readiness ? (readiness.releaseReady ? 'Ready' : 'Blocked') : 'Checking'}
            </StatusBadge>
          }
        />
        <div className="panel-body">
          <p className="muted">
            The readiness API validates this exact saved draft against secrets, capabilities, tools
            and its auto-derived plugin graph.
          </p>
          {readinessError && <Notice tone="danger">{readinessError}</Notice>}
          <ul className="check-list">
            <li>
              <span>{selected.config.name.trim() ? '✓' : '!'}</span> Identity present
            </li>
            <li>
              <span>{selected.config.processing.initial.trim() ? '✓' : '!'}</span> Initial
              processing phrase
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
            <Notice tone="danger">
              <strong>Blockers</strong>
              <ul>
                {readiness.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {readiness?.requiredPluginIds.length ? (
            <ul className="plain-list">
              {readiness.requiredPluginIds.map((id) => (
                <li key={id}>
                  <small className="mono">{id}</small>
                </li>
              ))}
            </ul>
          ) : null}
          <Notice tone="warning">
            {readiness?.liveBlockers?.[0] ??
              'Live admission still requires current capacity, transport and provider checks.'}
          </Notice>
        </div>
      </Panel>
      <Panel labelledBy="diff-title">
        <PanelHeader
          id="diff-title"
          title="Changes since release"
          badge={
            <StatusBadge tone={differences.length ? 'soft' : 'good'}>
              {latest ? `${differences.length} changes` : 'First release'}
            </StatusBadge>
          }
        />
        <div className="panel-body">
          {!latest ? (
            <p className="muted">
              The first release will snapshot the complete saved configuration.
            </p>
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
        </div>
      </Panel>
      <Panel labelledBy="release-title">
        <PanelHeader
          id="release-title"
          title="Immutable releases"
          badge={<StatusBadge>{releases.length}</StatusBadge>}
        />
        <div className="panel-body">
          {releases.length ? (
            <ol className="release-list">
              {releases.map((release) => (
                <li key={release.id}>
                  <strong className="mono">{release.id}</strong>
                  <small>
                    {release.createdAt
                      ? new Date(release.createdAt).toLocaleString()
                      : 'Timestamp unavailable'}{' '}
                    · {release.plugins?.length ?? 0} pinned plugins
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No published release">
              Publishing snapshots AgentConfig and a plugin lock. It does not mutate earlier
              releases.
            </EmptyState>
          )}
        </div>
      </Panel>
      <Panel labelledBy="extensions-title">
        <PanelHeader
          id="extensions-title"
          title="Console composition"
          badge={<StatusBadge tone="good">{extensions.length} plugins</StatusBadge>}
        />
        <div className="panel-body">
          <p className="muted">
            Forms and panels were registered through the server-side Cordis console extension
            registry.
          </p>
          <ul className="plain-list">
            {extensions.map((extension) => (
              <li key={extension.id}>
                <strong>{extension.label}</strong>
                <small className="mono">
                  {extension.ownerPluginId}@{extension.version}
                </small>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </aside>
  );
}
export function AgentDraftIndex({
  agents,
  select,
}: {
  agents: AgentDraft[];
  select: (agent: AgentDraft) => void;
}) {
  return (
    <Panel className="wide" labelledBy="agent-index-title">
      <PanelHeader id="agent-index-title" title="Organization drafts" />
      <ResponsiveTable label="Agent draft table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Mode</th>
            <th>Draft</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td>
                <button className="table-link" onClick={() => select(agent)}>
                  {agent.config.name}
                </button>
              </td>
              <td>{agent.config.mode}</td>
              <td>v{agent.draftVersion}</td>
              <td>
                {agent.updatedAt ? new Date(agent.updatedAt).toLocaleString() : 'Not supplied'}
              </td>
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
    </Panel>
  );
}
