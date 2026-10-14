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

/** Relative time with the absolute en-IN timestamp as a tooltip; re-renders itself every minute. */
export function RelativeTime({ value }: { value?: string | number | Date | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);
  if (value == null) return <span className="ds-unknown">Unknown</span>;
  return <time title={formatDateTime(value)}>{formatRelativeTime(value)}</time>;
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
