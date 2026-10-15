'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { formatDateTime, formatPhoneNumber } from '../../lib/format';
import { StatusBadgeV2 } from '../ui/status-badge';

type Lookup =
  | { listed: true; phoneNumber: string; reason: string; source: string; createdAt: string }
  | { listed: false; phoneNumber: string }
  | { error: string };

/**
 * "Check a number" as an inline toolbar search (brief: not its own card): answers for one number
 * without paging the whole list, and shows the result as a small chip beside the search field.
 */
export function DoNotCallLookup() {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<Lookup>();
  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phoneNumber = value.trim();
    if (!phoneNumber) return;
    setResult(undefined);
    try {
      const { data } = await apiRequest<Omit<Extract<Lookup, { listed: true }>, 'listed'>>(
        `/operations/suppressions/${encodeURIComponent(phoneNumber)}`,
      );
      setResult({ listed: true, ...data });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404)
        setResult({ listed: false, phoneNumber });
      else setResult({ error: failure instanceof Error ? failure.message : 'Lookup failed.' });
    }
  }
  return (
    <form className="ds-filter-row" onSubmit={check} role="search">
      <input
        type="tel"
        aria-label="Check a number against the do-not-call list"
        placeholder="Check a number, +91…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="button small" type="submit">
        Check
      </button>
      {result && 'error' in result && <StatusBadgeV2 tone="danger" label={result.error} />}
      {result && 'listed' in result && result.listed && (
        <StatusBadgeV2
          tone="warn"
          label={`${formatPhoneNumber(result.phoneNumber)} is listed · ${result.source === 'opt_out' ? 'caller opted out' : result.reason} · ${formatDateTime(result.createdAt)}`}
        />
      )}
      {result && 'listed' in result && !result.listed && (
        <StatusBadgeV2 tone="ok" label={`${formatPhoneNumber(result.phoneNumber)} is not listed`} />
      )}
    </form>
  );
}
