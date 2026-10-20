'use client';
import { useState } from 'react';
import type { Lines } from '../../lib/types/queues';

/** Spoken text per language (`{ en: '…', hi: '…' }`): one row each, plus a code to add another. */
export function LinesEditor({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: Lines | undefined;
  onChange: (value: Lines | undefined) => void;
  /** A required line keeps its last language; an optional one may be cleared entirely. */
  required?: boolean;
}) {
  const [code, setCode] = useState('');
  const entries = Object.entries(value ?? {});
  const emit = (next: Lines) => onChange(Object.keys(next).length || required ? next : undefined);
  const add = () => {
    const language = code.trim().toLowerCase();
    if (/^[a-z]{2,3}$/.test(language) && !(value && language in value))
      emit({ ...value, [language]: '' });
    setCode('');
  };
  return (
    <fieldset className="queue-lines">
      <legend>{label}</legend>
      {entries.map(([language, text]) => (
        <div key={language} className="queue-lines-row">
          <label>
            <span className="ds-chip">{language}</span>
            <input
              aria-label={`${label} (${language})`}
              value={text}
              maxLength={500}
              onChange={(event) => emit({ ...value, [language]: event.target.value })}
            />
          </label>
          {(!required || entries.length > 1) && (
            <button
              type="button"
              className="text-button"
              aria-label={`Remove ${language} from ${label}`}
              onClick={() => emit(Object.fromEntries(entries.filter(([key]) => key !== language)))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <div className="queue-lines-row">
        <input
          aria-label={`Add a language to ${label}`}
          placeholder="Add language, e.g. hi"
          value={code}
          maxLength={3}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="button" onClick={add}>
          Add
        </button>
      </div>
    </fieldset>
  );
}
