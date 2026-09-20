'use client';
import { useState } from 'react';
import { apiRequest } from '../../lib/api';
import type { CampaignPreview } from '../../lib/operator-api';
import { Field, Notice, ResponsiveTable, StatusBadge } from '../primitives';

export function CampaignContactImport({
  preview,
  onPreview,
}: {
  preview?: CampaignPreview;
  onPreview: (preview: CampaignPreview | undefined) => void;
}) {
  const [csv, setCsv] = useState('');
  const [phoneColumn, setPhoneColumn] = useState('');
  const [externalIdColumn, setExternalIdColumn] = useState('');
  const [variablesText, setVariablesText] = useState('{}');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const headers =
    preview?.headers ??
    csv
      .split(/\r?\n/, 1)[0]
      ?.split(',')
      .map((header) => header.trim().replace(/^"|"$/g, '')) ??
    [];
  function mapping() {
    const variables: unknown = JSON.parse(variablesText);
    if (!variables || typeof variables !== 'object' || Array.isArray(variables))
      throw new Error('Variable mapping must be a JSON object of variable name to CSV column.');
    return {
      phone: phoneColumn,
      ...(externalIdColumn ? { externalId: externalIdColumn } : {}),
      variables,
    };
  }
  async function runPreview() {
    setBusy(true);
    setError(undefined);
    onPreview(undefined);
    try {
      const { data } = await apiRequest<CampaignPreview>('/operations/campaigns/preview', {
        method: 'POST',
        body: JSON.stringify({ csv, mapping: mapping() }),
      });
      onPreview(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'CSV preview failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="nested-card">
      <legend>2 · Contact CSV preview</legend>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="CSV file" htmlFor="campaign-csv">
        <input
          id="campaign-csv"
          type="file"
          accept=".csv,text/csv"
          required
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void file.text().then((text) => {
                setCsv(text);
                onPreview(undefined);
              });
          }}
        />
      </Field>
      {csv && (
        <div className="form-grid">
          <Field label="Phone column" htmlFor="campaign-phone-column">
            <select
              id="campaign-phone-column"
              required
              value={phoneColumn}
              onChange={(event) => setPhoneColumn(event.target.value)}
            >
              <option value="">Select header</option>
              {headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </Field>
          <Field label="External ID column" htmlFor="campaign-external-column">
            <select
              id="campaign-external-column"
              value={externalIdColumn}
              onChange={(event) => setExternalIdColumn(event.target.value)}
            >
              <option value="">None</option>
              {headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Variable mapping JSON"
            htmlFor="campaign-vars"
            help='Example: {"customerName":"name"}'
          >
            <textarea
              id="campaign-vars"
              className="code-input compact-code"
              value={variablesText}
              onChange={(event) => setVariablesText(event.target.value)}
            />
          </Field>
        </div>
      )}
      <button
        className="button align-start"
        type="button"
        disabled={busy || !csv || !phoneColumn}
        onClick={() => void runPreview()}
      >
        Validate preview
      </button>
      {preview && (
        <>
          <div className="tool-meta">
            <StatusBadge tone={preview.errors.length ? 'danger' : 'good'}>
              {preview.rows.length} valid rows
            </StatusBadge>
            {preview.truncated && <StatusBadge tone="warning">Preview truncated</StatusBadge>}
          </div>
          {preview.errors.length ? (
            <Notice tone="danger">
              <strong>{preview.errors.length} rows require correction</strong>
              <ul>
                {preview.errors.slice(0, 20).map((item) => (
                  <li key={`${item.row}-${item.field}`}>
                    Row {item.row}, {item.field}: {item.message}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : (
            <ResponsiveTable label="Validated campaign contact preview">
              <thead>
                <tr>
                  <th>Source row</th>
                  <th>Phone</th>
                  <th>External ID</th>
                  <th>Variables</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 20).map((row) => (
                  <tr key={row.sourceRow}>
                    <td>{row.sourceRow}</td>
                    <td>{row.phoneNumber}</td>
                    <td>{row.externalId ?? '—'}</td>
                    <td>
                      <code>{JSON.stringify(row.variables)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          )}
        </>
      )}
    </fieldset>
  );
}
