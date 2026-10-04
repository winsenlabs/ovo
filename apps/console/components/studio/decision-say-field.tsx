'use client';
import { Field } from '../primitives';
import { withSay, type Outcome } from './decision-shapes';

/** The one authored field every answer branch shares: what the agent says when that branch wins. */
export function SayField({
  id,
  label,
  outcome,
  onChange,
}: {
  id: string;
  label: string;
  outcome: Outcome;
  onChange: (outcome: Outcome) => void;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      help="Spoken verbatim, with no LLM call. Leave empty to record the answer and let the LLM reply."
    >
      <textarea
        id={id}
        rows={2}
        value={outcome.say ?? ''}
        onChange={(event) => onChange(withSay(outcome, event.target.value))}
      />
    </Field>
  );
}
