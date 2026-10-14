import type { CSSProperties, ReactNode } from 'react';

export type Choice = {
  value: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  chips?: readonly string[];
  disabled?: boolean;
  disabledReason?: string;
};

/**
 * A radio-card group: the native `<input type="radio">` is visually hidden but focusable (so
 * keyboard/AT behaviour is free and correct) and the card around it carries the visible styling.
 * Fixes the "giant centred radio" defect without fighting the global input CSS.
 */
export function RadioCardGroup({
  name,
  value,
  onChange,
  choices,
  columns = 2,
  groupLabel,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  choices: readonly Choice[];
  columns?: 1 | 2 | 3 | 4;
  /** Accessible name for the group; required unless an external `<fieldset><legend>` wraps it. */
  groupLabel?: string;
}) {
  return (
    <div
      className="ds-choice-grid"
      role="radiogroup"
      aria-label={groupLabel}
      style={{ '--ds-choice-cols': columns } as CSSProperties}
    >
      {choices.map((choice) => (
        <label
          key={choice.value}
          className={`ds-choice-card ${value === choice.value ? 'selected' : ''} ${
            choice.disabled ? 'disabled' : ''
          }`}
          title={choice.disabled ? choice.disabledReason : undefined}
        >
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            disabled={choice.disabled}
            onChange={() => onChange(choice.value)}
          />
          <span className="ds-choice-check" aria-hidden="true" />
          <span className="ds-choice-body">
            <strong>{choice.title}</strong>
            {choice.description && <span className="muted">{choice.description}</span>}
            {choice.meta}
            {choice.chips && choice.chips.length > 0 && (
              <span className="ds-choice-chips">
                {choice.chips.map((chip) => (
                  <span key={chip} className="ds-chip">
                    {chip}
                  </span>
                ))}
              </span>
            )}
            {choice.disabled && choice.disabledReason && (
              <span className="ds-choice-disabled-reason">{choice.disabledReason}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
