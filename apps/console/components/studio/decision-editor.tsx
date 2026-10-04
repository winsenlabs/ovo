'use client';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { useRowKeys } from '../forms/use-row-keys';
import { ChoiceBranches, NoulBranches } from './decision-branches';
import { ScoreBranches } from './decision-score';
import { DecisionStatePanel } from './decision-state-panel';
import { DEFAULT_QUESTION, SOURCES, retyped, type Policy, type Question } from './decision-shapes';

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

  if (!policy)
    return (
      <Panel labelledBy="decision-title">
        <PanelHeader
          id="decision-title"
          title="Decision model"
          badge={<StatusBadge tone="soft">Not configured</StatusBadge>}
        />
        <div className="panel-body stack">
          <EmptyState title="No decision questions">
            A decision model answers a fixed question with a calibrated confidence, so a confident
            turn needs no LLM call at all. Below the confidence you set, the turn falls back.
            <button
              className="button primary"
              type="button"
              onClick={() =>
                setPolicy({
                  enabled: true,
                  questions: [DEFAULT_QUESTION()],
                  state: { sources: ['last-turn'], transcriptTurns: 6 },
                  timeoutMs: 1500,
                })
              }
            >
              Add a decision question
            </button>
          </EmptyState>
        </div>
      </Panel>
    );

  return (
    <Panel labelledBy="decision-title">
      <PanelHeader
        id="decision-title"
        title="Decision model"
        badge={
          <StatusBadge tone={policy.enabled ? 'good' : 'soft'}>
            {policy.enabled ? `${questions.length} live` : 'Disabled'}
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

        <DecisionStatePanel policy={policy} editPolicy={editPolicy} />

        {questions.map((question, index) => (
          <fieldset className="nested-card" key={rowKeys.keyAt(index)}>
            <legend>Question {index + 1}</legend>
            <div className="form-grid">
              <Field label="Stable ID" htmlFor={`decision-id-${index}`}>
                <input
                  id={`decision-id-${index}`}
                  value={question.id}
                  onChange={(event) => editQuestion(index, { ...question, id: event.target.value })}
                />
              </Field>
              <Field label="Answer shape" htmlFor={`decision-type-${index}`}>
                <select
                  id={`decision-type-${index}`}
                  value={question.type}
                  onChange={(event) =>
                    editQuestion(index, retyped(question, event.target.value as Question['type']))
                  }
                >
                  <option value="choice">One of several options</option>
                  <option value="noul">Yes or no</option>
                  <option value="score">A score against a rubric</option>
                </select>
              </Field>
              <Field
                label="Use the answer at or above"
                htmlFor={`decision-threshold-${index}`}
                help="Confidence, 0 to 1. Below this the answer is discarded."
              >
                <input
                  id={`decision-threshold-${index}`}
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={question.threshold}
                  onChange={(event) =>
                    editQuestion(index, { ...question, threshold: Number(event.target.value) })
                  }
                />
              </Field>
              <Field label="Below that, instead" htmlFor={`decision-fallback-${index}`}>
                <select
                  id={`decision-fallback-${index}`}
                  value={question.fallback}
                  onChange={(event) =>
                    editQuestion(index, {
                      ...question,
                      fallback: event.target.value as Question['fallback'],
                    })
                  }
                >
                  <option value="llm">Ask the LLM</option>
                  <option value="clarify">Ask the caller to repeat</option>
                </select>
              </Field>
            </div>
            <Field
              label="Why this question exists"
              htmlFor={`decision-purpose-${index}`}
              help="Your note. Never sent to the model."
            >
              <input
                id={`decision-purpose-${index}`}
                value={question.purpose}
                onChange={(event) =>
                  editQuestion(index, { ...question, purpose: event.target.value })
                }
              />
            </Field>
            <Field
              label="The question, as the model reads it"
              htmlFor={`decision-instructions-${index}`}
            >
              <textarea
                id={`decision-instructions-${index}`}
                value={question.instructions}
                onChange={(event) =>
                  editQuestion(index, { ...question, instructions: event.target.value })
                }
              />
            </Field>

            {question.type === 'choice' && (
              <ChoiceBranches
                index={index}
                question={question}
                onChange={(next) => editQuestion(index, next)}
              />
            )}
            {question.type === 'noul' && (
              <NoulBranches
                index={index}
                question={question}
                onChange={(next) => editQuestion(index, next)}
              />
            )}
            {question.type === 'score' && (
              <ScoreBranches
                index={index}
                question={question}
                onChange={(next) => editQuestion(index, next)}
              />
            )}

            <button
              className="text-button danger-text"
              type="button"
              onClick={() => {
                rowKeys.remove(index);
                const remaining = questions.filter((_, at) => at !== index);
                setPolicy(remaining.length ? { ...policy, questions: remaining } : undefined);
              }}
            >
              Remove question
            </button>
          </fieldset>
        ))}
        <button
          className="button align-start"
          type="button"
          onClick={() => {
            rowKeys.insert(questions.length);
            editPolicy({
              questions: [
                ...questions,
                { ...DEFAULT_QUESTION(), id: `question_${questions.length + 1}` },
              ],
            });
          }}
        >
          Add question
        </button>
        <div className="muted">
          All questions are asked together in one request, so a second question costs no extra round
          trip. The answers, the confidence and the calibration version are recorded on the call.
        </div>
      </div>
    </Panel>
  );
}
