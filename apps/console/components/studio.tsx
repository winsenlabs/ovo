'use client';
// The Configure tab's body: the agent's editors, regrouped into the brief's six named groups
// behind a sticky in-page nav, instead of one 7,000px unnavigable scroll (brief §3 "Agent detail
// / studio"). The agent switcher, "Organization drafts" and "Console composition" are gone —
// the switcher duplicated the Agents list, and the other two exposed internals no operator asked
// for. `AgentShell` (the layout above every `/agents/[id]/*` route) owns the shared header; the
// save-state badge here is this tab's own authoring status.
import { useRef, useState } from 'react';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import type { SessionIdentity } from '../lib/api';
import { StatusBadgeV2 } from './ui/status-badge';
import { EmptyStateV2, ErrorState, InlineAlert, Skeleton } from './ui/feedback-v2';
import { StudioRail } from './studio/release-panels';
import { DraftConflict } from './studio/draft-conflict';
import { StudioNav } from './studio/studio-nav';
import { buildStudioGroups } from './studio/studio-groups';
import { useAgentStudio } from './studio/use-agent-studio';
import { useReportSaveState } from './studio/save-state-context';

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
  useReportSaveState(saveState);
  const applyUpdate: typeof update = identity.role === 'viewer' ? () => undefined : update;
  const [activeGroup, setActiveGroup] = useState('basics');
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});

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
  const groups = buildStudioGroups({
    config,
    draftId: draft.id,
    identity,
    bindings,
    activeForms,
    update: applyUpdate,
  });

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
      {conflict != null && <DraftConflict config={config} conflict={conflict} onReload={load} />}
      {releaseError && <InlineAlert tone="danger">{releaseError}</InlineAlert>}
      {identity.role === 'viewer' && (
        <InlineAlert tone="info">
          Viewer access is read-only. Draft authoring and publishing controls are disabled.
        </InlineAlert>
      )}
      <select
        className="ds-studio-nav-select"
        aria-label="Jump to section"
        value={activeGroup}
        onChange={(event) => {
          const id = event.target.value;
          setActiveGroup(id);
          groupRefs.current[id]?.scrollIntoView({ block: 'start' });
        }}
      >
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.label}
          </option>
        ))}
      </select>
      <div className="studio-layout">
        <fieldset className="stack studio-editors" disabled={identity.role === 'viewer'}>
          {groups.map((group) => (
            <section
              id={`group-${group.id}`}
              className="ds-studio-group"
              key={group.id}
              ref={(element) => {
                groupRefs.current[group.id] = element;
              }}
            >
              <div className="ds-studio-group-head">
                <h2>{group.label}</h2>
              </div>
              {group.body}
            </section>
          ))}
        </fieldset>
        <aside className="studio-rail" aria-label="Configure navigation and release readiness">
          <StudioNav groups={groups} active={activeGroup} onActivate={setActiveGroup} />
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
