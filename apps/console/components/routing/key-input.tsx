'use client';
import { useEffect, useState } from 'react';

/**
 * A key (branch, queue) that renames on blur or Enter. `onCommit` returns why it refused, or
 * nothing; a refused rename puts the old key back. Committing once, not per keystroke, keeps
 * every reference to the key intact while it is typed.
 */
export function KeyInput({
  id,
  label,
  value,
  onCommit,
  error,
  help,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (next: string) => string | undefined;
  error?: string;
  help?: string;
}) {
  const [text, setText] = useState(value);
  const [problem, setProblem] = useState<string>();
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text === value) return setProblem(undefined);
    const refused = onCommit(text);
    setProblem(refused);
    if (refused) setText(value);
  };
  const shown = problem ?? error;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="mono"
        value={text}
        aria-invalid={shown ? true : undefined}
        aria-describedby={shown ? `${id}-error` : help ? `${id}-help` : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), commit())}
      />
      {help && <small id={`${id}-help`}>{help}</small>}
      {shown && (
        <small id={`${id}-error`} className="field-error">
          {shown}
        </small>
      )}
    </div>
  );
}
