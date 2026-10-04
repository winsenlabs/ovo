'use client';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { AgentConfig, SessionIdentity } from '../lib/api';
import {
  EmptyState,
  JsonEvidence,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  StatusBadge,
} from './primitives';
import { PluginField, ProviderMap } from './studio/configuration-panels';
import { FaqEditor } from './studio/faq-editor';
import { CostPolicyEditor } from './studio/cost-policy-editor';
import { SpeechCacheEditor } from './studio/speech-cache-editor';
import { AgentDraftIndex, StudioRail } from './studio/release-panels';
import { ScriptEditor } from './studio/script-editor';
import { ToolsEditor } from './studio/tools-editor';
import { useAgentStudio } from './studio/use-agent-studio';
import { AgentModePanel, RecordingPolicyPanel } from './studio/mode-policy-panels';
export function AgentStudio({
  extensions,
  identity,
  preferredAgentId,
}: {
  extensions: readonly ConsoleExtension[];
  identity: SessionIdentity;
  preferredAgentId?: string;
}) {
  const {
    agents,
    setSelected,
    selected,
    loading,
    loadError,
    load,
    saveState,
    saveError,
    conflict,
    bindings,
    releases,
    readiness,
    readinessError,
    releaseError,
    publishing,
    update,
    createAgent,
    publish,
    activeForms,
  } = useAgentStudio(extensions, preferredAgentId);
  const applyUpdate: typeof update = identity.role === 'viewer' ? () => undefined : update;
  if (loading) return <LoadingBlock label="Loading agents" />;
  if (loadError && !selected)
    return (
      <>
        <Notice tone="danger">{loadError}</Notice>
        <button className="button" onClick={load}>
          Retry
        </button>
      </>
    );
  if (!selected)
    return (
      <>
        <header className="page-heading">
          <div>
            <p className="eyebrow">Agent studio</p>
            <h1>Agents</h1>
            <p className="muted">Create a draft backed by the shared AgentConfig contract.</p>
          </div>
        </header>
        <EmptyState title="No agent drafts">
          The API returned an empty agent collection. No sample agent was inserted.
          <button
            className="button primary"
            disabled={identity.role === 'viewer'}
            onClick={createAgent}
          >
            Create agent
          </button>
        </EmptyState>
      </>
    );

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Agent studio</p>
          <div className="title-row">
            <h1>{selected.config.name}</h1>
            <StatusBadge tone="soft">Draft v{selected.draftVersion}</StatusBadge>
          </div>
          <p className="muted">Immutable releases stay separate from this optimistic draft.</p>
        </div>
        <div className="heading-actions">
          <select
            aria-label="Selected agent"
            value={selected.id}
            onChange={(event) =>
              setSelected(agents.find((agent) => agent.id === event.target.value))
            }
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.config.name}
              </option>
            ))}
          </select>
          <button className="button" onClick={createAgent} disabled={identity.role === 'viewer'}>
            New agent
          </button>
          <button
            className="button primary"
            onClick={publish}
            disabled={
              publishing ||
              !['idle', 'saved'].includes(saveState) ||
              identity.role === 'viewer' ||
              readiness?.releaseReady !== true
            }
          >
            {publishing
              ? 'Validating…'
              : readiness?.releaseReady === false
                ? `Resolve ${readiness.blockers.length} release blocker${readiness.blockers.length === 1 ? '' : 's'}`
                : !readiness
                  ? 'Checking release readiness'
                  : 'Publish release'}
          </button>
        </div>
      </header>
      <div className="save-banner" aria-live="polite">
        <StatusBadge
          tone={
            saveState === 'error' || saveState === 'conflict'
              ? 'danger'
              : saveState === 'saved'
                ? 'good'
                : 'soft'
          }
        >
          {
            (
              {
                idle: 'Loaded',
                dirty: 'Unsaved changes',
                saving: 'Saving draft',
                saved: 'Draft saved',
                error: 'Save failed',
                conflict: 'Edit conflict',
              } as const
            )[saveState]
          }
        </StatusBadge>
        {saveError && <span>{saveError}</span>}
      </div>
      {conflict && (
        <Notice tone="danger" live>
          <strong>This draft changed on the server.</strong> Your local edit was not overwritten.
          Compare both versions, then reload or copy the intended values.
          <div className="conflict-grid">
            <JsonEvidence label="Your local configuration" value={selected.config} />
            <JsonEvidence label="Current server draft" value={conflict} />
          </div>
          <button className="button" onClick={load}>
            Reload server draft
          </button>
        </Notice>
      )}
      {releaseError && (
        <Notice tone="danger" live>
          {releaseError}
        </Notice>
      )}
      {identity.role === 'viewer' && (
        <Notice>
          Viewer access is read-only. Draft authoring and publishing controls are disabled.
        </Notice>
      )}
      <div className="studio-layout">
        <fieldset className="stack studio-editors" disabled={identity.role === 'viewer'}>
          <AgentModePanel config={selected.config} role={identity.role} update={applyUpdate} />
          {activeForms.map((form) => (
            <Panel key={`${form.id}-${selected.id}`} labelledBy={`${form.id}-title`}>
              <PanelHeader
                id={`${form.id}-title`}
                title={form.title}
                badge={<StatusBadge tone="soft">Plugin form</StatusBadge>}
              />
              <div className="panel-body form-grid">
                {form.fields.map((field) => (
                  <PluginField
                    key={field.path}
                    field={field}
                    config={selected.config}
                    update={applyUpdate}
                  />
                ))}
              </div>
            </Panel>
          ))}
          {selected.config.mode === 'faq' && (
            <FaqEditor config={selected.config} update={applyUpdate} />
          )}
          {(selected.config.mode === 'announcement' || selected.config.mode === 'faq') && (
            <ScriptEditor config={selected.config} update={applyUpdate} />
          )}
          {(selected.config.mode === 'faq' || selected.config.mode === 'agent') && (
            <ToolsEditor config={selected.config} update={applyUpdate} />
          )}
          <ProviderMap config={selected.config} bindings={bindings} update={applyUpdate} />
          <SpeechCacheEditor config={selected.config} update={applyUpdate} />
          <CostPolicyEditor config={selected.config} update={applyUpdate} />
          <RecordingPolicyPanel
            config={selected.config}
            role={identity.role}
            update={applyUpdate}
          />
          <div className="desktop-authoring-note">
            <strong>Desktop is recommended for script table authoring.</strong> JSON import remains
            available on smaller screens, and diagnostics never depend on a canvas.
          </div>
        </fieldset>
        <StudioRail
          selected={selected}
          releases={releases}
          extensions={extensions}
          readiness={readiness}
          readinessError={readinessError}
        />
      </div>
      <AgentDraftIndex agents={agents} select={setSelected} />
    </>
  );
}
