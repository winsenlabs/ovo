import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { AgentDraft, Release } from '../../lib/api';
import { EmptyState, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';
export function StudioRail({
  selected,
  releases,
  extensions,
}: {
  selected: AgentDraft;
  releases: Release[];
  extensions: readonly ConsoleExtension[];
}) {
  return (
    <aside className="studio-rail" aria-label="Release readiness">
      <Panel labelledBy="readiness-title">
        <PanelHeader
          id="readiness-title"
          title="Release readiness"
          badge={<StatusBadge tone="warning">API validated</StatusBadge>}
        />
        <div className="panel-body">
          <p className="muted">
            Only the publish endpoint can certify this draft against secrets, capabilities, tools,
            tests and the plugin graph.
          </p>
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
              <span>?</span> Credentials, schemas and test evidence checked on publish
            </li>
          </ul>
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
      <PanelHeader id="agent-index-title" title="Workspace drafts" />
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
