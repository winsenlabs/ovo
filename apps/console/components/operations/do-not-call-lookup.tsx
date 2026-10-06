'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { Field, Notice, Panel, PanelHeader } from '../primitives';

type Lookup =
  | { listed: true; phoneNumber: string; reason: string; source: string; createdAt: string }
  | { listed: false; phoneNumber: string };

/** Is this number on the do-not-call list? Answers for one number without paging the list. */
export function DoNotCallLookup() {
  const [result, setResult] = useState<Lookup>();
  const [error, setError] = useState<string>();
  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phoneNumber = String(new FormData(event.currentTarget).get('lookup') ?? '').trim();
    setError(undefined);
    setResult(undefined);
    try {
      const { data } = await apiRequest<Omit<Extract<Lookup, { listed: true }>, 'listed'>>(
        `/operations/suppressions/${encodeURIComponent(phoneNumber)}`,
      );
      setResult({ listed: true, ...data });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404)
        setResult({ listed: false, phoneNumber });
      else setError(failure instanceof Error ? failure.message : 'Lookup failed.');
    }
  }
  return (
    <Panel labelledBy="dnc-lookup-title">
      <PanelHeader id="dnc-lookup-title" title="Check a number" />
      <form className="panel-body form-grid" onSubmit={check}>
        <Field label="Number to check" htmlFor="dnc-lookup">
          <input id="dnc-lookup" name="lookup" type="tel" placeholder="+91…" required />
        </Field>
        <button className="button align-start">Check</button>
      </form>
      <div className="panel-body" aria-live="polite">
        {error && <Notice tone="danger">{error}</Notice>}
        {result?.listed === true && (
          <Notice tone="warning">
            {result.phoneNumber} is listed (
            {result.source === 'opt_out' ? 'the caller opted out' : result.reason}) since{' '}
            {new Date(result.createdAt).toLocaleString()}. It will not be dialed.
          </Notice>
        )}
        {result?.listed === false && <Notice>{result.phoneNumber} is not on the list.</Notice>}
      </div>
    </Panel>
  );
}
