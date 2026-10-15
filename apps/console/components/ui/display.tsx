'use client';
import { useEffect, useState } from 'react';
import {
  formatDateTime,
  formatDuration,
  formatMoney,
  formatPercent,
  formatPhoneNumber,
  formatRelativeTime,
} from '../../lib/format';

/**
 * Relative time with the absolute en-IN timestamp as a tooltip; re-renders itself every minute.
 * `formatRelativeTime` reads `Date.now()`, which the server and the client never agree on, so
 * the first render (server and client alike) shows the deterministic absolute time instead and
 * only switches to the relative label after mount — the hydration hazard `components.md` warns
 * every caller about.
 */
export function RelativeTime({ value }: { value?: string | number | Date | null }) {
  const [relative, setRelative] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setRelative(formatRelativeTime(value));
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, [value]);
  if (value == null) return <span className="ds-unknown">Unknown</span>;
  return <time title={formatDateTime(value)}>{relative ?? formatDateTime(value)}</time>;
}

export function Money({
  minorUnits,
  currency = 'INR',
  provisional = false,
}: {
  minorUnits?: number | string | null;
  currency?: string;
  provisional?: boolean;
}) {
  return (
    <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {formatMoney(minorUnits, currency)}
      {provisional && <sup className="ds-provisional"> provisional</sup>}
    </span>
  );
}

export function Duration({ ms }: { ms?: number | null }) {
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(ms)}</span>;
}

export function Percent({ value, digits }: { value?: number | null; digits?: number }) {
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPercent(value, digits)}</span>;
}

export function PhoneNumber({ value }: { value?: string | null }) {
  return <span className="mono">{formatPhoneNumber(value)}</span>;
}

/** Visually-hidden native checkbox so a Switch is a real checkbox for assistive tech. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="ds-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ds-switch-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
