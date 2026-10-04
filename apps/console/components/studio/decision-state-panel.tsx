'use client';
import { Field, Notice } from '../primitives';
import { SOURCES, type Policy } from './decision-shapes';

/**
 * What the decision model is shown. The list is explicit rather than "everything available", so an
 * operator who asks a question about a document has to also say where that document comes from.
 */
export function DecisionStatePanel({
  policy,
  editPolicy,
}: {
  policy: Policy;
  editPolicy: (patch: Partial<Policy>) => void;
}) {
  return (
    <fieldset className="nested-card">
      <legend>What the model is shown</legend>
      <p className="muted">
        A decision can only be grounded in what is listed here. Nothing else is sent, however
        available it is to the agent.
      </p>
      {SOURCES.map((source) => (
        <Field
          key={source.id}
          label={source.label}
          htmlFor={`decision-source-${source.id}`}
          help={source.help}
        >
          <input
            id={`decision-source-${source.id}`}
            type="checkbox"
            checked={policy.state.sources.includes(source.id)}
            onChange={(event) =>
              editPolicy({
                state: {
                  ...policy.state,
                  sources: event.target.checked
                    ? [...policy.state.sources, source.id]
                    : policy.state.sources.filter((entry) => entry !== source.id),
                },
              })
            }
          />
        </Field>
      ))}
      {!policy.state.sources.length && (
        <Notice tone="danger">
          A decision grounded in nothing is a guess. Choose at least one source.
        </Notice>
      )}
      {policy.state.sources.includes('transcript') && (
        <Field label="Transcript turns" htmlFor="decision-transcript-turns">
          <input
            id="decision-transcript-turns"
            type="number"
            min={1}
            max={50}
            value={policy.state.transcriptTurns}
            onChange={(event) =>
              editPolicy({
                state: { ...policy.state, transcriptTurns: Number(event.target.value) },
              })
            }
          />
        </Field>
      )}
    </fieldset>
  );
}
