'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, items } from '../../lib/api';
import { Field, Notice, Panel, PanelHeader, ResponsiveTable } from '../primitives';
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
  const [message, setMessage] = useState<{ tone: 'neutral' | 'danger'; text: string }>();
  const report = (tone: 'neutral' | 'danger', text: string) => setMessage({ tone, text });
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
      report('neutral', 'Consent recorded.');
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
      report('neutral', `${data.stored} scrub results stored; ${data.ncprListed} fully blocked.`);
    } catch (failure) {
      report('danger', failureText(failure, 'Scrub results could not be stored.'));
    }
  }
  return (
    <Panel labelledBy="consents-title">
      <PanelHeader id="consents-title" title="Consent and DND scrub" />
      {message && (
        <Notice tone={message.tone} live>
          {message.text}
        </Notice>
      )}
      <div className="panel-body form-grid">
        <Field label="Phone number" htmlFor="consent-phone">
          <input
            id="consent-phone"
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>
        <button className="button align-start" disabled={!phone} onClick={() => void lookup()}>
          Look up consents
        </button>
      </div>
      {consents && (
        <ResponsiveTable label="Consents on record">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Basis</th>
              <th>Valid</th>
            </tr>
          </thead>
          <tbody>
            {consents.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.principalEntity} · {row.purpose}
                  <small>{row.category}</small>
                </td>
                <td>
                  {row.basis}
                  <small className="mono">{row.evidenceRef}</small>
                </td>
                <td>
                  {row.revokedAt
                    ? `Revoked ${new Date(row.revokedAt).toLocaleDateString()}`
                    : row.expiresAt
                      ? `Until ${new Date(row.expiresAt).toLocaleString()}`
                      : 'Until revoked'}
                </td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      )}
      <form className="panel-body form-grid" onSubmit={record}>
        <fieldset disabled={!canEdit || !phone} className="form-grid">
          <Field label="Brand (principal entity)" htmlFor="consent-pe">
            <input id="consent-pe" name="principalEntity" required />
          </Field>
          <Field label="Purpose" htmlFor="consent-purpose">
            <input id="consent-purpose" name="purpose" required />
          </Field>
          <Field label="Category" htmlFor="consent-category">
            <select id="consent-category" name="category" defaultValue="service">
              <option value="service">Service</option>
              <option value="promotional">Promotional</option>
              <option value="transactional">Transactional</option>
            </select>
          </Field>
          <Field label="Basis" htmlFor="consent-basis">
            <select id="consent-basis" name="basis" defaultValue="explicit_service_7d">
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
          </Field>
          <Field
            label="Evidence reference"
            htmlFor="consent-evidence"
            help="DLT consent ID, CRF reference, or your inquiry record."
          >
            <input id="consent-evidence" name="evidenceRef" required />
          </Field>
          <Field label="Obtained" htmlFor="consent-obtained">
            <input id="consent-obtained" name="obtainedAt" type="datetime-local" required />
          </Field>
          <label className="toggle-row">
            <input type="checkbox" name="customerInitiated" />
            <span>The customer opted in on their own (allowed inside the 90-day lock)</span>
          </label>
          <button className="button align-start">Record consent</button>
        </fieldset>
      </form>
      <form className="panel-body form-grid" onSubmit={upload}>
        <fieldset disabled={!canEdit} className="form-grid">
          <Field
            label="DND scrub results (phone,result per line)"
            htmlFor="scrub-rows"
            help="result is allowed, blocked, fully_blocked or unknown, as your telco or RTM portal reports it."
          >
            <textarea id="scrub-rows" name="rows" rows={4} required />
          </Field>
          <button className="button align-start">Upload scrub results</button>
        </fieldset>
      </form>
    </Panel>
  );
}
