'use client';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { ListTextInput } from '../forms/list-text-input';

type Policy = NonNullable<AgentConfig['knowledge']>;

const DEFAULT_POLICY = (): Policy => ({
  enabled: true,
  sourceIds: [],
  topK: 4,
  minScore: 0.4,
  maxCharacters: 4000,
  timeoutMs: 1000,
  requireGrounding: false,
});

/**
 * Grounding, per agent. The corpus itself belongs to the selected knowledge plugin's row config on
 * the plugins page; this is the policy over it — which sources, how deep, how weak a match is still
 * acceptable, and how much retrieved text one turn may spend.
 */
export function KnowledgeEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const policy = config.knowledge;
  const edit = (patch: Partial<Policy>) => {
    if (!policy) return;
    update({ ...config, knowledge: { ...policy, ...patch } });
  };

  if (!policy)
    return (
      <Panel labelledBy="knowledge-title">
        <PanelHeader
          id="knowledge-title"
          title="Grounding"
          badge={<StatusBadge tone="soft">Not configured</StatusBadge>}
        />
        <div className="panel-body stack">
          <EmptyState title="The agent is not grounded">
            Without grounding, an agent knows only its briefing text — which is pasted into every
            request whole, and fails publication above its budget rather than being searched. With
            it, each turn retrieves only the passages that match, with a citation for each.
            <button
              className="button primary"
              type="button"
              onClick={() => update({ ...config, knowledge: DEFAULT_POLICY() })}
            >
              Ground this agent
            </button>
          </EmptyState>
        </div>
      </Panel>
    );

  return (
    <Panel labelledBy="knowledge-title">
      <PanelHeader
        id="knowledge-title"
        title="Grounding"
        badge={
          <StatusBadge tone={policy.enabled ? 'good' : 'soft'}>
            {policy.enabled ? `top ${policy.topK}` : 'Disabled'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <div className="form-grid">
          <Field label="Retrieve on every turn" htmlFor="knowledge-enabled">
            <input
              id="knowledge-enabled"
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) => edit({ enabled: event.target.checked })}
            />
          </Field>
          <Field
            label="Passages to retrieve"
            htmlFor="knowledge-topk"
            help="More passages means more of the prompt spent on retrieved text."
          >
            <input
              id="knowledge-topk"
              type="number"
              min={1}
              max={50}
              value={policy.topK}
              onChange={(event) => edit({ topK: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Use a passage at or above"
            htmlFor="knowledge-minscore"
            help="Relevance, 0 to 1. Below this a passage is discarded before anything sees it."
          >
            <input
              id="knowledge-minscore"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={policy.minScore}
              onChange={(event) => edit({ minScore: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Characters of retrieved text per turn"
            htmlFor="knowledge-budget"
            help="Passages are kept in rank order until the budget is spent. A passage is dropped whole, never cut."
          >
            <input
              id="knowledge-budget"
              type="number"
              min={100}
              max={40000}
              value={policy.maxCharacters}
              onChange={(event) => edit({ maxCharacters: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Retrieval deadline (ms)"
            htmlFor="knowledge-timeout"
            help="Retrieval sits in front of the reply, so its latency is audible."
          >
            <input
              id="knowledge-timeout"
              type="number"
              min={50}
              max={10000}
              value={policy.timeoutMs}
              onChange={(event) => edit({ timeoutMs: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Refuse rather than answer ungrounded"
            htmlFor="knowledge-require"
            help="For an agent whose answers are only safe when grounded — a policy, a price, an eligibility rule."
          >
            <input
              id="knowledge-require"
              type="checkbox"
              checked={policy.requireGrounding}
              onChange={(event) => edit({ requireGrounding: event.target.checked })}
            />
          </Field>
        </div>
        <Field
          label="Sources this agent may read (one per line)"
          htmlFor="knowledge-sources"
          help="Leave empty for every source the selected knowledge plugin carries. The ids are the plugin’s own."
        >
          <ListTextInput
            id="knowledge-sources"
            value={policy.sourceIds}
            onChange={(sourceIds) => edit({ sourceIds })}
          />
        </Field>
        {policy.requireGrounding && (
          <Notice tone="warning">
            Every turn with no passage above {policy.minScore} will answer with the uncertainty line
            instead of reaching the LLM. Check the threshold against real questions first.
          </Notice>
        )}
        <div className="muted">
          The documents themselves are configured on the plugins page, under the selected knowledge
          plugin. Each retrieved passage keeps its citation, and the corpus revision is recorded
          against the call.
        </div>
        <button
          className="text-button danger-text align-start"
          type="button"
          onClick={() => update({ ...config, knowledge: undefined })}
        >
          Remove grounding
        </button>
      </div>
    </Panel>
  );
}
