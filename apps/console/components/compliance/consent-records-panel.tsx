'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, items } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { SectionCard } from '../ui/section-card';
import { formatDateTime } from '../../lib/format';
import { humaniseEnum } from '../../lib/status';
import { failureText, type ConsentRecord } from './compliance-types';
import { RecordConsentDrawer, UploadScrubResultsDrawer } from './consent-records-forms';

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
 * promotional calls need (fail-closed without a fresh `allowed`). Recording a consent or
 * uploading a scrub file opens in a drawer rather than sitting open as a form under the table.
 */
export function ConsentRecordsPanel({ canEdit }: { canEdit: boolean }) {
  const [phone, setPhone] = useState('');
  const [consents, setConsents] = useState<ConsentRecord[]>();
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string }>();
  const [drawer, setDrawer] = useState<'consent' | 'upload' | null>(null);
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
      setDrawer(null);
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
      setDrawer(null);
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
          <small className="muted">{humaniseEnum(row.category)}</small>
        </>
      ),
    },
    {
      id: 'basis',
      header: 'Basis',
      cell: (row) => (
        <>
          {humaniseEnum(row.basis)}
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
      <SectionCard
        title="Consent on record"
        padding="flush"
        description="Look up a number, then record a consent against it."
        actions={
          <div className="button-row">
            <button
              className="button small"
              type="button"
              disabled={!canEdit}
              onClick={() => setDrawer('upload')}
            >
              Upload scrub results
            </button>
            <button
              className="button small primary"
              type="button"
              disabled={!canEdit || !phone}
              onClick={() => setDrawer('consent')}
            >
              Record consent
            </button>
          </div>
        }
      >
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
      </SectionCard>
      <RecordConsentDrawer
        open={drawer === 'consent'}
        phone={phone}
        canEdit={canEdit}
        onClose={() => setDrawer(null)}
        onSubmit={(event) => void record(event)}
      />
      <UploadScrubResultsDrawer
        open={drawer === 'upload'}
        canEdit={canEdit}
        onClose={() => setDrawer(null)}
        onSubmit={(event) => void upload(event)}
      />
    </div>
  );
}
