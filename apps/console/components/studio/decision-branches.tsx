'use client';
import { Field } from '../primitives';
import { SayField } from './decision-say-field';
import { STARTER, type Question } from './decision-shapes';

/** The per-answer branches of one question: its options, its yes/no sides, or its score bands. */
export function ChoiceBranches({
  index,
  question,
  onChange,
}: {
  index: number;
  question: Extract<Question, { type: 'choice' }>;
  onChange: (next: Question) => void;
}) {
  const edit = (at: number, patch: Partial<(typeof question.options)[number]>) =>
    onChange({
      ...question,
      options: question.options.map((row, current) =>
        current === at ? { ...row, ...patch } : row,
      ),
    });
  return (
    <fieldset className="nested-card">
      <legend>Options, and what each one does</legend>
      <Field
        label="The answer you expect"
        htmlFor={`decision-expected-${index}`}
        help="Recorded so you can see how often reality differed. Never sent to the model."
      >
        <select
          id={`decision-expected-${index}`}
          value={question.expected ?? ''}
          onChange={(event) => onChange({ ...question, expected: event.target.value || undefined })}
        >
          <option value="">No expectation</option>
          {question.options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.key}
            </option>
          ))}
        </select>
      </Field>
      {question.options.map((option, at) => (
        <fieldset className="nested-card" key={`${index}-option-${at}`}>
          <legend>Option {at + 1}</legend>
          <Field label="Key" htmlFor={`decision-${index}-key-${at}`}>
            <input
              id={`decision-${index}-key-${at}`}
              value={option.key}
              onChange={(event) => edit(at, { key: event.target.value })}
            />
          </Field>
          <Field
            label="What this option means"
            htmlFor={`decision-${index}-desc-${at}`}
            help="Sent to the model. This is the only authored text it reads."
          >
            <textarea
              id={`decision-${index}-desc-${at}`}
              rows={2}
              value={option.description}
              onChange={(event) => edit(at, { description: event.target.value })}
            />
          </Field>
          <SayField
            id={`decision-${index}-say-${at}`}
            label="Then say"
            outcome={option.outcome}
            onChange={(outcome) => edit(at, { outcome })}
          />
          {question.options.length > 2 && (
            <button
              className="text-button danger-text"
              type="button"
              onClick={() =>
                onChange({
                  ...question,
                  options: question.options.filter((_, current) => current !== at),
                  ...(question.expected === option.key ? { expected: undefined } : {}),
                })
              }
            >
              Remove option
            </button>
          )}
        </fieldset>
      ))}
      <button
        className="button align-start"
        type="button"
        onClick={() =>
          onChange({
            ...question,
            options: [
              ...question.options,
              {
                key: `option_${question.options.length + 1}`,
                description: STARTER.option,
                outcome: {},
              },
            ],
          })
        }
      >
        Add option
      </button>
    </fieldset>
  );
}

export function NoulBranches({
  index,
  question,
  onChange,
}: {
  index: number;
  question: Extract<Question, { type: 'noul' }>;
  onChange: (next: Question) => void;
}) {
  return (
    <fieldset className="nested-card">
      <legend>Yes and no, and what each one does</legend>
      <Field
        label="The answer you expect"
        htmlFor={`decision-expected-${index}`}
        help="Recorded so you can see how often reality differed. Never sent to the model."
      >
        <select
          id={`decision-expected-${index}`}
          value={question.expected ?? ''}
          onChange={(event) =>
            onChange({
              ...question,
              expected: (event.target.value || undefined) as 'yes' | 'no' | undefined,
            })
          }
        >
          <option value="">No expectation</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </Field>
      {(['yes', 'no'] as const).map((side) => (
        <fieldset className="nested-card" key={side}>
          <legend>{side === 'yes' ? 'Yes' : 'No'}</legend>
          <Field label="What counts as this" htmlFor={`decision-${index}-${side}-desc`}>
            <textarea
              id={`decision-${index}-${side}-desc`}
              rows={2}
              value={question[side].description}
              onChange={(event) =>
                onChange({
                  ...question,
                  [side]: { ...question[side], description: event.target.value },
                })
              }
            />
          </Field>
          <SayField
            id={`decision-${index}-${side}-say`}
            label="Then say"
            outcome={question[side].outcome}
            onChange={(outcome) =>
              onChange({ ...question, [side]: { ...question[side], outcome } })
            }
          />
        </fieldset>
      ))}
    </fieldset>
  );
}
