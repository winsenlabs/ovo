'use client';
import { useEffect, useState } from 'react';

export interface Locator {
  id: string;
  versionId?: string;
}

function locators(value: unknown): Locator[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as Locator).id === 'string'
      ? [
          {
            id: (entry as Locator).id,
            ...(typeof (entry as Locator).versionId === 'string'
              ? { versionId: (entry as Locator).versionId }
              : {}),
          },
        ]
      : [],
  );
}

/**
 * A short list of `{id, versionId}` locators, such as an ElevenLabs pronunciation dictionary: one
 * row each, an id and an optional version. Binding forms render any array of `{id}` objects so.
 */
export function LocatorListField({
  field: { id, label, help, max },
  value,
  onChange,
}: {
  field: { id: string; label: string; help?: string; max: number };
  value: unknown;
  onChange: (next: Locator[] | undefined) => void;
}) {
  const saved = locators(value);
  const [rows, setRows] = useState<Locator[]>(() => (saved.length ? saved : [{ id: '' }]));
  // Another editor (the Advanced JSON) changed the value: show what it now holds.
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    if (JSON.stringify(kept(rows)) !== savedKey) setRows(saved.length ? saved : [{ id: '' }]);
  }, [savedKey]);
  const update = (next: Locator[]) => {
    setRows(next.length ? next : [{ id: '' }]);
    const value = kept(next);
    onChange(value.length ? value : undefined);
  };
  const edit = (index: number, patch: Partial<Locator>) =>
    update(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="field" aria-describedby={help ? `${id}-help` : undefined}>
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div className="ui-cluster" key={index}>
          <label htmlFor={`${id}-${index}-id`}>Dictionary {index + 1} ID</label>
          <input
            id={`${id}-${index}-id`}
            value={row.id}
            spellCheck={false}
            onChange={(event) => edit(index, { id: event.target.value })}
          />
          <label htmlFor={`${id}-${index}-version`}>Version</label>
          <input
            id={`${id}-${index}-version`}
            value={row.versionId ?? ''}
            placeholder="latest"
            spellCheck={false}
            onChange={(event) => edit(index, { versionId: event.target.value })}
          />
          <button
            className="button small"
            type="button"
            aria-label={`Remove dictionary ${index + 1}`}
            onClick={() => update(rows.filter((_, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      {rows.length < max && (
        <button
          className="button small"
          type="button"
          onClick={() => setRows([...rows, { id: '' }])}
        >
          Add dictionary
        </button>
      )}
      {help && <small id={`${id}-help`}>{help}</small>}
    </fieldset>
  );
}

/** Rows with an id, trimmed; a half-typed row never reaches the binding. */
function kept(rows: readonly Locator[]): Locator[] {
  return rows
    .map((row) => ({
      id: row.id.trim(),
      ...(row.versionId?.trim() ? { versionId: row.versionId.trim() } : {}),
    }))
    .filter((row) => row.id);
}
