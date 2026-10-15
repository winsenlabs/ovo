import type { ReactNode } from 'react';
import type { AgentConfig, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { ConsoleForm } from '@winsendotai/ovo-ui';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { JsonViewer } from '../ui/code-block';
import { PluginField, ProviderMap } from './configuration-panels';
import { FaqEditor } from './faq-editor';
import { CostPolicyEditor } from './cost-policy-editor';
import { DecisionEditor } from './decision-editor';
import { IdleEditor } from './idle-editor';
import { JevOnlyPanel } from './jev-only-panel';
import { RecoveryEditor } from './recovery-editor';
import { RulesEditor } from './rules-editor';
import { KnowledgeEditor } from './knowledge-editor';
import { CallPolicyPanels } from './call-policy-panels';
import { ScriptEditor } from './script-editor';
import { ToolsEditor } from './tools-editor';
import { AgentModePanel, RecordingPolicyPanel } from './mode-policy-panels';

export type Group = { id: string; label: string; body: ReactNode };

/** The Configure tab's six named groups (brief §3 "Agent detail / studio"), split out of
 * `studio.tsx` to stay under the module-size gate. Pure view over the loaded draft — no state or
 * effects of its own. */
export function buildStudioGroups({
  config,
  draftId,
  identity,
  bindings,
  activeForms,
  update,
}: {
  config: AgentConfig;
  draftId: string;
  identity: SessionIdentity;
  bindings: ProviderBinding[];
  activeForms: readonly ConsoleForm[];
  update: (next: AgentConfig) => void;
}): Group[] {
  return [
    {
      id: 'basics',
      label: 'Basics',
      body: (
        <>
          <AgentModePanel config={config} role={identity.role} update={update} />
          {activeForms.map((form) => (
            <SectionCard
              title={form.title}
              actions={<StatusBadgeV2 tone="neutral" label="Plugin form" />}
              key={`${form.id}-${draftId}`}
            >
              <div className="form-grid">
                {form.fields.map((field) => (
                  <PluginField key={field.path} field={field} config={config} update={update} />
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
          {config.mode === 'faq' && <FaqEditor config={config} update={update} />}
          {(config.mode === 'announcement' || config.mode === 'faq') && (
            <ScriptEditor config={config} update={update} />
          )}
          {config.mode === 'agent' && (
            <>
              <KnowledgeEditor config={config} update={update} />
              <DecisionEditor config={config} update={update} />
              <RulesEditor config={config} update={update} />
              <RecoveryEditor config={config} update={update} />
              <IdleEditor config={config} update={update} />
              <JevOnlyPanel config={config} update={update} />
            </>
          )}
          {config.mode !== 'agent' && config.script && (
            <DecisionEditor config={config} update={update} />
          )}
        </>
      ),
    },
    {
      id: 'tools',
      label: 'Tools',
      body:
        config.mode === 'faq' || config.mode === 'agent' ? (
          <ToolsEditor config={config} update={update} />
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
          <CallPolicyPanels config={config} update={update} />
          <RecordingPolicyPanel config={config} role={identity.role} update={update} />
        </>
      ),
    },
    {
      id: 'cost',
      label: 'Cost',
      body: <CostPolicyEditor config={config} update={update} agentId={draftId} />,
    },
    {
      id: 'advanced',
      label: 'Advanced',
      body: (
        <>
          {Object.keys(config.providers ?? {}).length > 0 && (
            <ProviderMap config={config} bindings={bindings} update={update} />
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
}
