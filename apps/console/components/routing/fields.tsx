'use client';
import type { ReactNode } from 'react';
import { Switch } from '../ui/display';
import { FormField } from '../ui/form-field';
import { NumberInput, Select, TagInput } from '../ui/inputs';

/** Select options from a `{ value: label }` map, in the map's order. Written as a map because a
 * list of `{ value, label }` literals is token-identical from one option list to the next. */
export function optionsFrom(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/**
 * Thin, labelled wrappers over the design-system controls, so the queue forms say what each
 * field is and nothing about markup. Every field takes the validation message for its path.
 */
export function TextField({
  id,
  label,
  value,
  onChange,
  help,
  error,
  required,
  placeholder,
  type = 'text',
  mono,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  type?: 'text' | 'url';
  mono?: boolean;
}) {
  return (
    <FormField id={id} label={label} help={help} error={error} required={required}>
      {(control) => (
        <input
          {...control}
          type={type}
          className={mono ? 'mono' : undefined}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  unit,
  min,
  max,
  help,
  error,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  help?: string;
  error?: string;
}) {
  return (
    <FormField id={id} label={label} help={help} error={error}>
      {(control) => (
        <NumberInput
          id={control.id}
          value={value}
          min={min}
          max={max}
          unit={unit}
          onChange={(next) => next !== null && onChange(next)}
        />
      )}
    </FormField>
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  help,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  error?: string;
}) {
  return (
    <FormField id={id} label={label} help={help} error={error}>
      {(control) => (
        <Select
          id={control.id}
          value={value}
          placeholder={placeholder}
          options={options}
          onChange={onChange}
        />
      )}
    </FormField>
  );
}

export function TagsField({
  id,
  label,
  values,
  onChange,
  placeholder,
  help,
  error,
}: {
  id: string;
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  help?: string;
  error?: string;
}) {
  return (
    <FormField id={id} label={label} help={help} error={error}>
      {() => (
        <TagInput
          values={values}
          placeholder={placeholder}
          ariaLabel={label}
          onChange={(next) => onChange([...next])}
        />
      )}
    </FormField>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  help?: ReactNode;
}) {
  return (
    <div className="field">
      <Switch label={label} checked={checked} onChange={onChange} />
      {help && <small>{help}</small>}
    </div>
  );
}

/** A titled group of fields inside the drawer form. */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="queue-section">
      <legend>{title}</legend>
      {description && <p className="muted">{description}</p>}
      {children}
    </fieldset>
  );
}

/** A multi-line text field (instructions, descriptions). */
export function TextAreaField({
  id,
  label,
  value,
  onChange,
  help,
  error,
  rows = 3,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  error?: string;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <FormField id={id} label={label} help={help} error={error}>
      {(control) => (
        <textarea
          {...control}
          rows={rows}
          maxLength={maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

/** A number with a fractional step (a 0 to 1 confidence threshold). */
export function DecimalField({
  id,
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  help,
  error,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  error?: string;
}) {
  return (
    <FormField id={id} label={label} help={help} error={error}>
      {(control) => (
        <input
          {...control}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => event.target.value !== '' && onChange(Number(event.target.value))}
        />
      )}
    </FormField>
  );
}
