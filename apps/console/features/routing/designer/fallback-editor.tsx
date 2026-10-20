'use client';
import { ROUTING_LIMITS, type FallbackStep, type RoutingNode } from '@winsendotai/ovo-contracts';
import { LinesEditor } from '../../../components/routing/lines-editor';
import {
  NumberField,
  optionsFrom,
  SelectField,
  SwitchField,
} from '../../../components/routing/fields';
import { IssueList } from '../../../components/routing/issue-list';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { issuesAt } from '../../../lib/derive/routing-anchor';
import { blankFallback, blankTarget } from '../../../lib/derive/routing-defaults';
import { moveStep, removeStep } from '../../../lib/derive/routing-edit';
import { chainIsTerminal, FALLBACK_LABEL } from '../../../lib/derive/routing-labels';
import { useDesigner } from './designer-context';
import { TargetEditor } from './target-editor';

const KINDS = optionsFrom(FALLBACK_LABEL);

function StepBody({
  step,
  onChange,
  id,
  node,
}: {
  step: FallbackStep;
  onChange: (s: FallbackStep) => void;
  id: string;
  node: RoutingNode;
}) {
  const { draft } = useDesigner();
  const queueKeys = (draft.humanQueues ?? []).map((b) => b.key);
  switch (step.kind) {
    case 'reask':
      return (
        <>
          <NumberField
            id={`${id}-times`}
            label="Ask again up to"
            unit="times"
            min={1}
            max={3}
            value={step.times}
            onChange={(times) => onChange({ ...step, times })}
          />
          <LinesEditor
            label="Re-ask line (optional)"
            value={step.line}
            onChange={(line) =>
              onChange({ kind: 'reask', times: step.times, ...(line ? { line } : {}) })
            }
          />
          {!step.line && !node.ask && (
            <p className="muted">
              With no line here or on the question, a question that needs the caller cannot be asked
              again.
            </p>
          )}
        </>
      );
    case 'default':
      return (
        <>
          <SwitchField
            label="Use the point's default agent"
            checked={!step.target}
            help="Off: choose where this step sends the call."
            onChange={(on) =>
              onChange(on ? { kind: 'default' } : { kind: 'default', target: blankTarget('agent') })
            }
          />
          {step.target && (
            <TargetEditor
              id={`${id}-target`}
              value={step.target}
              kinds={['pool', 'agent', 'human', 'callback', 'end']}
              onChange={(target) => onChange({ kind: 'default', target })}
            />
          )}
        </>
      );
    case 'human':
      return (
        <SelectField
          id={`${id}-queue`}
          label="Person queue"
          value={step.queueId}
          placeholder={queueKeys.length ? 'Choose a queue…' : 'Bind a queue first'}
          options={queueKeys.map((k) => ({ value: k, label: k }))}
          onChange={(queueId) => onChange({ ...step, queueId })}
        />
      );
    case 'callback':
      return (
        <>
          <NumberField
            id={`${id}-minutes`}
            label="Call back in"
            unit="minutes"
            min={5}
            max={10080}
            value={step.inMinutes}
            onChange={(inMinutes) => onChange({ ...step, inMinutes })}
          />
          <LinesEditor
            label="Promise to the caller"
            required
            value={step.line}
            onChange={(line) => line && onChange({ ...step, line })}
          />
        </>
      );
    case 'end':
      return (
        <LinesEditor
          label="Goodbye line"
          required
          value={step.line}
          onChange={(line) => line && onChange({ ...step, line })}
        />
      );
  }
}

/** What happens when no engine can decide: each step is tried in turn, the last one must end the road. */
export function FallbackEditor({
  node,
  onChange,
}: {
  node: RoutingNode;
  onChange: (node: RoutingNode) => void;
}) {
  const { index } = useDesigner();
  const set = (fallback: FallbackStep[]) => onChange({ ...node, fallback });
  return (
    <div className="rt-stack">
      <p className="muted">
        Tried in order when no engine decides. If every step fails the point&apos;s default agent is
        tried once more, then the call ends politely.
      </p>
      {!chainIsTerminal(node.fallback) && (
        <InlineAlert tone="danger">
          This chain must end with the default agent, a callback or ending the call, so a caller is
          never left without somewhere to go.
        </InlineAlert>
      )}
      <IssueList
        issues={issuesAt(index, node.id, 'fallback').filter(
          (a) =>
            a.anchor.stepIndex === undefined && a.issue.code !== 'routing_fallback_not_terminal',
        )}
      />
      <ol className="queue-rows" aria-label="Fallback steps">
        {node.fallback.map((step, s) => (
          <li key={s} className="rt-card">
            <div className="rt-card-head">
              <SelectField
                id={`${node.id}-f${s}-kind`}
                label={`Step ${s + 1}`}
                value={step.kind}
                options={KINDS}
                onChange={(kind) =>
                  set(
                    node.fallback.map((x, i) =>
                      i === s ? blankFallback(kind as FallbackStep['kind']) : x,
                    ),
                  )
                }
              />
              <span className="rt-row-actions">
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move fallback step ${s + 1} up`}
                  disabled={s === 0}
                  onClick={() => set(moveStep(node.fallback, s, -1))}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move fallback step ${s + 1} down`}
                  disabled={s === node.fallback.length - 1}
                  onClick={() => set(moveStep(node.fallback, s, 1))}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove fallback step ${s + 1}`}
                  disabled={node.fallback.length <= 1}
                  onClick={() => set(removeStep(node.fallback, s, 1))}
                >
                  Remove
                </button>
              </span>
            </div>
            <StepBody
              id={`${node.id}-f${s}`}
              node={node}
              step={step}
              onChange={(next) => set(node.fallback.map((x, i) => (i === s ? next : x)))}
            />
            <IssueList issues={issuesAt(index, node.id, 'fallback', { stepIndex: s })} />
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="button"
        disabled={node.fallback.length >= ROUTING_LIMITS.fallbackSteps}
        onClick={() => set([...node.fallback, blankFallback('end')])}
      >
        Add step
      </button>
    </div>
  );
}
