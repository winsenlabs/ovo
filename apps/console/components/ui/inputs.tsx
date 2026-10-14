'use client';
import { useState, type DragEvent } from 'react';

export function Select({
  value,
  onChange,
  options,
  placeholder,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput({
  value,
  onChange,
  unit,
  min,
  max,
  id,
  ariaLabel,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  unit?: string;
  min?: number;
  max?: number;
  id?: string;
  /** Required when the caller does not pair this input with an external `<label htmlFor>`. */
  ariaLabel?: string;
}) {
  return (
    <div className="ds-number-input">
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value ?? ''}
        aria-label={ariaLabel}
        onChange={(event) =>
          onChange(event.target.value === '' ? null : Number(event.target.value))
        }
      />
      {unit && <span className="ds-number-unit">{unit}</span>}
    </div>
  );
}

/** Comma/Enter-delimited chip input for `string[]` schema fields. */
export function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: readonly string[];
  onChange: (values: readonly string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const tag = draft.trim();
    if (tag && !values.includes(tag)) onChange([...values, tag]);
    setDraft('');
  };
  return (
    <div className="ds-tag-input">
      {values.map((tag) => (
        <span key={tag} className="ds-chip">
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(values.filter((value) => value !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

/** CSV/JSON drop zone with a lightweight parsed-row preview, used by every import drawer. */
export function FileDrop({
  accept,
  onFile,
  hint,
}: {
  accept: string;
  onFile: (file: File) => void;
  hint: string;
}) {
  const [dragging, setDragging] = useState(false);
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    // A native `<label>` around the file input is the one drop-zone shape that is clickable
    // end to end without a second, nested interactive role (axe `nested-interactive`).
    <label
      className={`ds-file-drop ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        type="file"
        accept={accept}
        className="sr-only"
        aria-label={hint}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <span>{hint}</span>
    </label>
  );
}
