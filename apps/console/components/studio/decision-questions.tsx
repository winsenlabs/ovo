'use client';
import { Field } from '../primitives';
import type { useRowKeys } from '../forms/use-row-keys';
import { ChoiceBranches, NoulBranches } from './decision-branches';
import { ScoreBranches } from './decision-score';
import { DecisionStatePanel } from './decision-state-panel';
import { DEFAULT_QUESTION, retyped, type Policy, type Question } from './decision-shapes';

/** The flat questions, asked together on every turn. */
export function DecisionQuestions({
  policy,
  editPolicy,
  setPolicy,
  editQuestion,
  rowKeys,
}: {
  policy: Policy;
  editPolicy: (patch: Partial<Policy>) => void;
  setPolicy: (next: Policy | undefined) => void;
  editQuestion: (index: number, next: Question) => void;
  rowKeys: ReturnType<typeof useRowKeys>;
}) {
  const questions = policy.questions;
  return (
    <>
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
    </>
  );
}
