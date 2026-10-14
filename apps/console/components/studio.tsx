'use client';
// The Configure tab's body: the agent's editors, regrouped into the brief's six named groups
// behind a sticky in-page nav, instead of one 7,000px unnavigable scroll (brief §3 "Agent detail
// / studio"). The agent switcher, "Organization drafts" and "Console composition" are gone —
// the switcher duplicated the Agents list, and the other two exposed internals no operator asked
// for. `AgentShell` (the layout above every `/agents/[id]/*` route) owns the shared header; the
// save-state badge here is this tab's own authoring status.
import type { ReactNode } from 'react';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { SessionIdentity } from '../lib/api';
import { SectionCard } from './ui/section-card';
import { StatusBadgeV2 } from './ui/status-badge';
import { EmptyStateV2, ErrorState, InlineAlert, Skeleton } from './ui/feedback-v2';
import { JsonViewer } from './ui/code-block';
import { PluginField, ProviderMap } from './studio/configuration-panels';
import { FaqEditor } from './studio/faq-editor';
import { CostPolicyEditor } from './studio/cost-policy-editor';
import { DecisionEditor } from './studio/decision-editor';
import { IdleEditor } from './studio/idle-editor';
import { JevOnlyPanel } from './studio/jev-only-panel';
import { RecoveryEditor } from './studio/recovery-editor';
import { RulesEditor } from './studio/rules-editor';
import { KnowledgeEditor } from './studio/knowledge-editor';
import { CallPolicyPanels } from './studio/call-policy-panels';
import { StudioRail } from './studio/release-panels';
import { ScriptEditor } from './studio/script-editor';
import { ToolsEditor } from './studio/tools-editor';
import { useAgentStudio } from './studio/use-agent-studio';
import { AgentModePanel, RecordingPolicyPanel } from './studio/mode-policy-panels';

type Group = { id: string; label: string; body: ReactNode };

const SAVE_LABEL = {
  idle: 'Loaded',
  dirty: 'Unsaved changes',
  saving: 'Saving draft',
  saved: 'Draft saved',
  error: 'Save failed',
  conflict: 'Edit conflict',
} as const;

export function AgentStudio({
  agentId,
  identity,
  extensions,
}: {
  agentId: string;
  identity: SessionIdentity;
  extensions: readonly ConsoleExtension[];
}) {
  const {
    draft,
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
    update,
    activeForms,
  } = useAgentStudio(agentId, extensions);
  const applyUpdate: typeof update = identity.role === 'viewer' ? () => undefined : update;

  if (loading)
    return (
      <div className="studio-layout">
        <div className="stack studio-editors">
          <Skeleton shape="block" />
          <Skeleton shape="block" />
          <Skeleton shape="block" />
        </div>
      </div>
    );
  if (loadError && !draft) return <ErrorState message={loadError} onRetry={load} />;
  if (!draft) return <EmptyStateV2 variant="unavailable" title="This agent could not be loaded" />;
  const config = draft.config;

  const groups: Group[] = [
    {
      id: 'basics',
      label: 'Basics',
      body: (
        <>
          <AgentModePanel config={config} role={identity.role} update={applyUpdate} />
          {activeForms.map((form) => (
            <SectionCard
              title={form.title}
              actions={<StatusBadgeV2 tone="neutral" label="Plugin form" />}
              key={`${form.id}-${draft.id}`}
            >
              <div className="form-grid">
                {form.fields.map((field) => (
                  <PluginField
                    key={field.path}
                    field={field}
                    config={config}
                    update={applyUpdate}
                  />
                ))}
              </div>
            </SectionCard>
          ))}
        </>
      ),
    },
    {
      id: 'conversation',
      label: 'Conversation',
      body: (
        <>
          {config.mode === 'faq' && <FaqEditor config={config} update={applyUpdate} />}
          {(config.mode === 'announcement' || config.mode === 'faq') && (
            <ScriptEditor config={config} update={applyUpdate} />
          )}
          {config.mode === 'agent' && (
            <>
              <KnowledgeEditor config={config} update={applyUpdate} />
              <DecisionEditor config={config} update={applyUpdate} />
              <RulesEditor config={config} update={applyUpdate} />
              <RecoveryEditor config={config} update={applyUpdate} />
              <IdleEditor config={config} update={applyUpdate} />
              <JevOnlyPanel config={config} update={applyUpdate} />
            </>
          )}
          {config.mode !== 'agent' && config.script && (
            <DecisionEditor config={config} update={applyUpdate} />
          )}
        </>
      ),
    },
    {
      id: 'tools',
      label: 'Tools',
      body:
        config.mode === 'faq' || config.mode === 'agent' ? (
          <ToolsEditor config={config} update={applyUpdate} />
        ) : (
          <EmptyStateV2 title="Tools are not available in this mode">
            Switch to FAQ or Agent mode in Basics to approve tools.
          </EmptyStateV2>
        ),
    },
    {
      id: 'call-policy',
      label: 'Call policy',
      body: (
        <>
          <CallPolicyPanels config={config} update={applyUpdate} />
          <RecordingPolicyPanel config={config} role={identity.role} update={applyUpdate} />
        </>
      ),
    },
    {
      id: 'cost',
      label: 'Cost',
      body: <CostPolicyEditor config={config} update={applyUpdate} agentId={draft.id} />,
    },
    {
      id: 'advanced',
      label: 'Advanced',
      body: (
        <>
          {Object.keys(config.providers ?? {}).length > 0 && (
            <ProviderMap config={config} bindings={bindings} update={applyUpdate} />
          )}
          {identity.role === 'admin' && (
            <SectionCard title="Raw configuration">
              <JsonViewer
                value={config}
                label="Show raw AgentConfig"
                filename="agent-config.json"
              />
            </SectionCard>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="ui-stack">
      <div className="save-banner" aria-live="polite">
        <StatusBadgeV2
          tone={
            saveState === 'error' || saveState === 'conflict'
              ? 'danger'
              : saveState === 'saved'
                ? 'ok'
                : 'neutral'
          }
          label={SAVE_LABEL[saveState]}
        />
        {saveError && <span>{saveError}</span>}
      </div>
      {conflict != null && (
        <InlineAlert tone="danger">
          <strong>This draft changed on the server.</strong> Your local edit was not overwritten.
          Compare both versions, then reload or copy the intended values.
          <div className="conflict-grid">
            <JsonViewer value={config} label="Your local configuration" />
            <JsonViewer value={conflict} label="Current server draft" />
          </div>
          <button className="button" onClick={load}>
            Reload server draft
          </button>
        </InlineAlert>
      )}
      {releaseError && <InlineAlert tone="danger">{releaseError}</InlineAlert>}
      {identity.role === 'viewer' && (
        <InlineAlert tone="info">
          Viewer access is read-only. Draft authoring and publishing controls are disabled.
        </InlineAlert>
      )}
      <div className="studio-layout">
        <fieldset className="stack studio-editors" disabled={identity.role === 'viewer'}>
          {groups.map((group) => (
            <section id={`group-${group.id}`} className="ds-studio-group" key={group.id}>
              <div className="ds-studio-group-head">
                <h2>{group.label}</h2>
              </div>
              {group.body}
            </section>
          ))}
        </fieldset>
        <aside className="studio-rail" aria-label="Configure navigation and release readiness">
          <nav className="ds-studio-nav" aria-label="Jump to section">
            {groups.map((group) => (
              <a key={group.id} href={`#group-${group.id}`}>
                {group.label}
              </a>
            ))}
          </nav>
          <StudioRail
            selected={draft}
            releases={releases}
            readiness={readiness}
            readinessError={readinessError}
          />
        </aside>
      </div>
    </div>
  );
}
