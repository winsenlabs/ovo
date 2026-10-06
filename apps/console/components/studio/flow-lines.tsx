'use client';
import { useEffect, useRef, useState } from 'react';
import { Field } from '../primitives';
import type { Flow } from './flow-shapes';

/**
 * Every line the flow can speak, editable in place. `{{name}}` reads a call variable; a line
 * without one is the same on every call, so it is rendered once and played from the clip cache.
 */
export function FlowLines({ flow, onChange }: { flow: Flow; onChange: (next: Flow) => void }) {
  const entries = Object.entries(flow.lines);
  return (
    <fieldset className="nested-card">
      <legend>Lines</legend>
      {entries.map(([id, text]) => (
        <LineField
          key={id}
          id={id}
          text={text}
          onChange={(next) => onChange({ ...flow, lines: { ...flow.lines, [id]: next } })}
        />
      ))}
      {entries.length === 0 && <p className="muted">This flow has no lines yet.</p>}
    </fieldset>
  );
}

/** An emptied line stays local until it has text again: the draft is saved on every edit. */
function LineField({
  id,
  text,
  onChange,
}: {
  id: string;
  text: string;
  onChange: (next: string) => void;
}) {
  const [value, setValue] = useState(text);
  const sent = useRef(text);
  // A replaced flow (an import) brings new text; an edit of ours coming back does not reset it.
  useEffect(() => {
    if (text === sent.current) return;
    sent.current = text;
    setValue(text);
  }, [text]);
  return (
    <Field
      label={id}
      htmlFor={`flow-line-${id}`}
      help={/{{|}}/.test(value) ? 'Rendered per call' : 'Pre-rendered once'}
      error={value.trim() ? undefined : 'A line cannot be empty.'}
    >
      <textarea
        id={`flow-line-${id}`}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          if (!next.trim()) return;
          sent.current = next;
          onChange(next);
        }}
      />
    </Field>
  );
}
