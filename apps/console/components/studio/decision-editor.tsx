'use client';
import type { AgentConfig } from '../../lib/api';
import { Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { useRowKeys } from '../forms/use-row-keys';
import { DecisionQuestions } from './decision-questions';
import { DecisionStart } from './decision-start';
import type { Policy, Question } from './decision-shapes';
import { FlowEditor } from './flow-editor';

export function DecisionEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const policy = config.decision;
  const questions = policy?.questions ?? [];
  const rowKeys = useRowKeys(questions.length);
  const setPolicy = (next: Policy | undefined) =>
    update({ ...config, ...(next ? { decision: next } : { decision: undefined }) });
  const editPolicy = (patch: Partial<Policy>) => {
    if (!policy) return;
    setPolicy({ ...policy, ...patch });
  };
  const editQuestion = (index: number, next: Question) =>
    editPolicy({ questions: questions.map((row, at) => (at === index ? next : row)) });

  // Outside agent mode only a script asks the decision model, to match replies to transitions.
  const scripted = config.mode !== 'agent';
  if (!policy) return <DecisionStart scripted={scripted} setPolicy={setPolicy} />;
  const live = scripted
    ? 'Matching replies'
    : policy.flow
      ? `${policy.flow.nodes.length}-state flow`
      : `${questions.length} live`;

  return (
    <Panel labelledBy="decision-title">
      <PanelHeader
        id="decision-title"
        title="Decision model"
        badge={
          <StatusBadge tone={policy.enabled ? 'good' : 'soft'}>
            {policy.enabled ? live : 'Disabled'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <div className="form-grid">
          <Field label="Run decisions on this agent" htmlFor="decision-enabled">
            <input
              id="decision-enabled"
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) => editPolicy({ enabled: event.target.checked })}
            />
          </Field>
          <Field
            label="Answer deadline (ms)"
            htmlFor="decision-timeout"
            help="A decision sits in front of the reply, so its latency is audible. On timeout the turn falls back."
          >
            <input
              id="decision-timeout"
              type="number"
              min={50}
              max={10000}
              value={policy.timeoutMs}
              onChange={(event) => editPolicy({ timeoutMs: Number(event.target.value) })}
            />
          </Field>
        </div>

        {scripted && (
          <>
            <p className="muted">
              A reply that matches no transition exactly is classified among the current node&apos;s
              transitions. Only a clear answer moves the script; anything else falls through to the
              FAQ or the clarification line, as before.
            </p>
            <button
              className="text-button danger-text align-start"
              type="button"
              onClick={() => setPolicy(undefined)}
            >
              Stop matching with the decision model
            </button>
          </>
        )}
        {!scripted && policy.flow && (
          <FlowEditor
            flow={policy.flow}
            onChange={(flow) => editPolicy({ flow })}
            onRemove={() => setPolicy(undefined)}
          />
        )}
        {!scripted && !policy.flow && (
          <DecisionQuestions
            policy={policy}
            editPolicy={editPolicy}
            setPolicy={setPolicy}
            editQuestion={editQuestion}
            rowKeys={rowKeys}
          />
        )}
      </div>
    </Panel>
  );
}
