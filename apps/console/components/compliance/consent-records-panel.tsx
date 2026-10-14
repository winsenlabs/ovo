'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, items } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { formatDateTime } from '../../lib/format';
import { failureText, type ConsentRecord } from './compliance-types';

/** Reads `phone,result` lines exported from a telco or telemarketer DND scrub portal. */
export function parseScrubRows(text: string) {
  return text
    .split('\n')
    .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')))
    .filter(
      ([phone, result]) =>
        /^\+\d{8,15}$/.test(phone ?? '') &&
        /^(allowed|blocked|fully_blocked|unknown)$/.test(result ?? ''),
    )
    .map(([phoneNumber, result]) => ({ phoneNumber: phoneNumber!, result: result! }));
}

/**
 * Consent records per number (explicit, 7-day service, inquiry) and the DND scrub upload that
 * promotional calls need (fail-closed without a fresh `allowed`).
 */
export function ConsentRecordsPanel({ canEdit }: { canEdit: boolean }) {
  const [phone, setPhone] = useState('');
  const [consents, setConsents] = useState<ConsentRecord[]>();
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string }>();
  const report = (tone: 'info' | 'danger', text: string) => setMessage({ tone, text });
  async function lookup() {
    try {
      const { data } = await apiRequest<unknown>(
        `/operations/compliance/consents?phoneNumber=${encodeURIComponent(phone)}`,
      );
      setConsents(items<ConsentRecord>(data));
    } catch (failure) {
      report('danger', failureText(failure, 'Consents unavailable.'));
    }
  }
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (name: string) => String(values.get(name) ?? '').trim();
    try {
      await apiRequest('/operations/compliance/consents', {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: phone,
          principalEntity: text('principalEntity'),
          purpose: text('purpose'),
          category: text('category'),
          basis: text('basis'),
          evidenceRef: text('evidenceRef'),
          obtainedAt: new Date(text('obtainedAt')).toISOString(),
          customerInitiated: values.get('customerInitiated') === 'on',
        }),
      });
      report('info', 'Consent recorded.');
      await lookup();
    } catch (failure) {
      report('danger', failureText(failure, 'Consent could not be recorded.'));
    }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rows = parseScrubRows(String(new FormData(event.currentTarget).get('rows') ?? ''));
    try {
      const { data } = await apiRequest<{ stored: number; ncprListed: number }>(
        '/operations/compliance/preferences/upload',
        { method: 'POST', body: JSON.stringify({ rows }) },
      );
      report('info', `${data.stored} scrub results stored; ${data.ncprListed} fully blocked.`);
    } catch (failure) {
      report('danger', failureText(failure, 'Scrub results could not be stored.'));
    }
  }

  const columns: ColumnV2<ConsentRecord>[] = [
    {
      id: 'scope',
      header: 'Scope',
      cell: (row) => (
        <>
          {row.principalEntity} · {row.purpose}
          <br />
          <small className="muted">{row.category}</small>
        </>
      ),
    },
    {
      id: 'basis',
      header: 'Basis',
      cell: (row) => (
        <>
          {row.basis}
          <br />
          <small className="mono">{row.evidenceRef}</small>
        </>
      ),
    },
    {
      id: 'valid',
      header: 'Valid',
      cell: (row) =>
        row.revokedAt
          ? `Revoked ${formatDateTime(row.revokedAt)}`
          : row.expiresAt
            ? `Until ${formatDateTime(row.expiresAt)}`
            : 'Until revoked',
    },
  ];

  return (
    <div className="stack">
      {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
      <div className="ds-filter-row">
        <FormField id="consent-phone" label="Phone number">
          {(control) => (
            <input
              {...control}
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          )}
        </FormField>
        <button className="button align-start" disabled={!phone} onClick={() => void lookup()}>
          Look up consents
        </button>
      </div>
      {consents && (
        <DataTableV2
          key={consents.length === 0 ? 'empty' : 'data'}
          label="Consents on record"
          rows={consents}
          columns={columns}
          rowKey={(row) => row.id}
          empty="No consent on record for this number"
        />
      )}
      <form className="form-grid nested-card" onSubmit={record}>
        <fieldset disabled={!canEdit || !phone} className="form-grid">
          <FormField id="consent-pe" label="Brand (principal entity)">
            {(control) => <input {...control} name="principalEntity" required />}
          </FormField>
          <FormField id="consent-purpose" label="Purpose">
            {(control) => <input {...control} name="purpose" required />}
          </FormField>
          <FormField id="consent-category" label="Category">
            {(control) => (
              <select {...control} name="category" defaultValue="service">
                <option value="service">Service</option>
                <option value="promotional">Promotional</option>
                <option value="transactional">Transactional</option>
              </select>
            )}
          </FormField>
          <FormField id="consent-basis" label="Basis">
            {(control) => (
              <select {...control} name="basis" defaultValue="explicit_service_7d">
                {[
                  'explicit_service_7d',
                  'inquiry_7d',
                  'application_3m',
                  'explicit_registered',
                  'explicit_legacy_registered',
                  'transaction_30min',
                  'inferred_relationship',
                ].map((basis) => (
                  <option key={basis}>{basis}</option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="consent-evidence"
            label="Evidence reference"
            help="DLT consent ID, CRF reference, or your inquiry record."
          >
            {(control) => <input {...control} name="evidenceRef" required />}
          </FormField>
          <FormField id="consent-obtained" label="Obtained">
            {(control) => <input {...control} name="obtainedAt" type="datetime-local" required />}
          </FormField>
          <label className="toggle-row">
            <input type="checkbox" name="customerInitiated" />
            <span>The customer opted in on their own (allowed inside the 90-day lock)</span>
          </label>
          <button className="button align-start" style={{ alignSelf: 'start' }}>
            Record consent
          </button>
        </fieldset>
      </form>
      <form className="form-grid nested-card" onSubmit={upload}>
        <fieldset disabled={!canEdit} className="form-grid">
          <FormField
            id="scrub-rows"
            label="DND scrub results (phone,result per line)"
            help="result is allowed, blocked, fully_blocked or unknown, as your telco or RTM portal reports it."
          >
            {(control) => <textarea {...control} name="rows" rows={4} required />}
          </FormField>
          <button className="button align-start" style={{ alignSelf: 'start' }}>
            Upload scrub results
          </button>
        </fieldset>
      </form>
    </div>
  );
}
