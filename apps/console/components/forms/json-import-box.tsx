'use client';
import { useState } from 'react';
export function JsonImportBox({
  label,
  onImport,
}: {
  label: string;
  onImport: (value: unknown) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  return (
    <div className="field">
      <label htmlFor="json-import">{label}</label>
      <textarea
        id="json-import"
        value={text}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'json-import-error' : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      {error && (
        <small className="field-error" id="json-import-error">
          {error}
        </small>
      )}
      <button
        type="button"
        className="button"
        onClick={() => {
          try {
            onImport(JSON.parse(text));
            setError(undefined);
          } catch {
            setError('Enter valid JSON.');
          }
        }}
      >
        Import JSON
      </button>
    </div>
  );
}
