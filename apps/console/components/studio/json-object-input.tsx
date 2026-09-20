'use client';
import { useEffect, useState } from 'react';

export function JsonObjectInput({
  id,
  value,
  onValid,
}: {
  id: string;
  value: unknown;
  onValid: (value: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <>
      <textarea
        id={id}
        className="code-input compact-code"
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const next: unknown = JSON.parse(text);
            if (!next || typeof next !== 'object' || Array.isArray(next))
              throw new Error('Expected object');
            onValid(next as Record<string, unknown>);
            setError(undefined);
          } catch {
            setError('Enter a valid JSON object.');
          }
        }}
      />
      {error && <small className="field-error">{error}</small>}
    </>
  );
}
