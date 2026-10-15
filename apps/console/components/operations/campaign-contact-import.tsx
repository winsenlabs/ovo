'use client';
import { useState } from 'react';
import { apiRequest } from '../../lib/api';
import type { CampaignPreview } from '../../lib/operator-api';
import { FormField } from '../ui/form-field';
import { FileDrop } from '../ui/inputs';
import { StatusBadgeV2 } from '../ui/status-badge';
import { ErrorState } from '../ui/feedback-v2';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';

/** The server's preview, with the rows already on the do-not-call list (never dialed). */
export type CompliancePreview = CampaignPreview & { doNotCall?: number[] };

type PreviewRow = CompliancePreview['rows'][number];

export function CampaignContactImport({
  preview,
  onPreview,
  releaseId,
}: {
  preview?: CompliancePreview;
  onPreview: (preview: CompliancePreview | undefined) => void;
  /** When set, each row's variables are checked against this release's declared schema. */
  releaseId?: string;
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
      const { data } = await apiRequest<CompliancePreview>('/operations/campaigns/preview', {
        method: 'POST',
        body: JSON.stringify({ csv, mapping: mapping(), ...(releaseId ? { releaseId } : {}) }),
      });
      onPreview(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'CSV preview failed.');
    } finally {
      setBusy(false);
    }
  }
  const previewColumns: ColumnV2<PreviewRow>[] = [
    { id: 'sourceRow', header: 'Source row', cell: (row) => row.sourceRow },
    {
      id: 'phone',
      header: 'Phone',
      cell: (row) => <span className="mono">{row.phoneNumber}</span>,
    },
    { id: 'externalId', header: 'External ID', cell: (row) => row.externalId ?? '—' },
    {
      id: 'variables',
      header: 'Variables',
      cell: (row) => <code>{JSON.stringify(row.variables)}</code>,
    },
  ];
  return (
    <div className="stack">
      {error && <ErrorState message={error} />}
      <p className="eyebrow">Contact CSV</p>
      <FileDrop
        accept=".csv,text/csv"
        hint="Drop a CSV file here, or click to choose one"
        onFile={(file) => {
          void file.text().then((text) => {
            setCsv(text);
            onPreview(undefined);
          });
        }}
      />
      {/* No filename line here: FileDrop (`../ui/inputs.tsx`) already shows the chosen file's
          name above its own raw-text preview; repeating it duplicated the filename on screen. */}
      {csv && (
        <div className="form-grid">
          <FormField id="campaign-phone-column" label="Phone column">
            {(control) => (
              <select
                {...control}
                required
                value={phoneColumn}
                onChange={(event) => setPhoneColumn(event.target.value)}
              >
                <option value="">Select header</option>
                {headers.map((header) => (
                  <option key={header}>{header}</option>
                ))}
              </select>
            )}
          </FormField>
          <FormField id="campaign-external-column" label="External ID column">
            {(control) => (
              <select
                {...control}
                value={externalIdColumn}
                onChange={(event) => setExternalIdColumn(event.target.value)}
              >
                <option value="">None</option>
                {headers.map((header) => (
                  <option key={header}>{header}</option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="campaign-vars"
            label="Variable mapping JSON"
            help='Example: {"customerName":"name"}'
          >
            {(control) => (
              <textarea
                {...control}
                className="code-input compact-code"
                value={variablesText}
                onChange={(event) => setVariablesText(event.target.value)}
              />
            )}
          </FormField>
        </div>
      )}
      <button
        className="button align-start"
        type="button"
        disabled={busy || !csv || !phoneColumn}
        onClick={() => void runPreview()}
      >
        {busy ? 'Validating…' : 'Validate preview'}
      </button>
      {preview && (
        <>
          <div className="tool-meta">
            <StatusBadgeV2
              tone={preview.errors.length ? 'danger' : 'ok'}
              label={`${preview.rows.length} valid rows`}
            />
            {preview.truncated && <StatusBadgeV2 tone="warn" label="Preview truncated" />}
            {Boolean(preview.doNotCall?.length) && (
              <StatusBadgeV2
                tone="warn"
                label={`${preview.doNotCall!.length} on the do-not-call list (rows ${preview.doNotCall!.slice(0, 10).join(', ')}${preview.doNotCall!.length > 10 ? '…' : ''}); they import but are never dialed`}
              />
            )}
          </div>
          {preview.errors.length ? (
            <ErrorState
              title={`${preview.errors.length} rows require correction`}
              message={preview.errors
                .slice(0, 20)
                .map((item) => `Row ${item.row}, ${item.field}: ${item.message}`)
                .join('; ')}
            />
          ) : (
            <DataTableV2
              key={preview.rows.length === 0 ? 'empty' : 'data'}
              label="Validated campaign contact preview"
              rows={preview.rows.slice(0, 20)}
              columns={previewColumns}
              rowKey={(row) => String(row.sourceRow)}
            />
          )}
        </>
      )}
    </div>
  );
}
