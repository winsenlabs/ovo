'use client';
import { Field } from '../primitives';
import { ListTextInput } from '../forms/list-text-input';
import { SayField } from './decision-say-field';
import type { Question } from './decision-shapes';

/** A score question's rubric and the bands that turn a score into an outcome. */
export function ScoreBranches({
  index,
  question,
  onChange,
}: {
  index: number;
  question: Extract<Question, { type: 'score' }>;
  onChange: (next: Question) => void;
}) {
  const top = question.rubric.length - 1;
  return (
    <fieldset className="nested-card">
      <legend>Rubric, and what each band does</legend>
      <Field
        label="Rubric levels, lowest first (one per line)"
        htmlFor={`decision-${index}-rubric`}
        help={`The model scores between 0 and ${top}.`}
      >
        <ListTextInput
          id={`decision-${index}-rubric`}
          value={question.rubric}
          onChange={(rubric) => onChange({ ...question, rubric })}
        />
      </Field>
      <Field
        label="The score you expect, at least"
        htmlFor={`decision-expected-${index}`}
        help="Recorded so you can see how often reality differed. Never sent to the model."
      >
        <input
          id={`decision-expected-${index}`}
          type="number"
          min={0}
          max={top}
          step={0.1}
          value={question.expectedAtLeast ?? ''}
          onChange={(event) =>
            onChange({
              ...question,
              expectedAtLeast: event.target.value === '' ? undefined : Number(event.target.value),
            })
          }
        />
      </Field>
      {question.bands.map((band, at) => (
        <fieldset className="nested-card" key={`${index}-band-${at}`}>
          <legend>Band {at + 1}</legend>
          <Field
            label="Applies from"
            htmlFor={`decision-${index}-band-${at}`}
            help={at === 0 ? 'One band must start at 0, so every score resolves.' : undefined}
          >
            <input
              id={`decision-${index}-band-${at}`}
              type="number"
              min={0}
              max={top}
              step={0.1}
              value={band.atLeast}
              onChange={(event) =>
                onChange({
                  ...question,
                  bands: question.bands.map((row, current) =>
                    current === at ? { ...row, atLeast: Number(event.target.value) } : row,
                  ),
                })
              }
            />
          </Field>
          <SayField
            id={`decision-${index}-band-say-${at}`}
            label="Then say"
            outcome={band.outcome}
            onChange={(outcome) =>
              onChange({
                ...question,
                bands: question.bands.map((row, current) =>
                  current === at ? { ...row, outcome } : row,
                ),
              })
            }
          />
          {question.bands.length > 1 && (
            <button
              className="text-button danger-text"
              type="button"
              onClick={() =>
                onChange({
                  ...question,
                  bands: question.bands.filter((_, current) => current !== at),
                })
              }
            >
              Remove band
            </button>
          )}
        </fieldset>
      ))}
      <button
        className="button align-start"
        type="button"
        onClick={() =>
          onChange({ ...question, bands: [...question.bands, { atLeast: top, outcome: {} }] })
        }
      >
        Add band
      </button>
    </fieldset>
  );
}
