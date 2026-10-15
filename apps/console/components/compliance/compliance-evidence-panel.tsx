'use client';
import { useState } from 'react';
import { FormField } from '../ui/form-field';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { ProgressMeter } from '../charts/meter';
import { formatPercent } from '../../lib/format';
import type { CliRatio } from './compliance-types';

const today = () => new Date().toISOString().slice(0, 10);

/** The regulator export link for a date range, in UTC days. */
export function exportHref(from: string, to: string): string {
  const range = new URLSearchParams({
    from: new Date(`${from}T00:00:00Z`).toISOString(),
    to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(),
  });
  return `/api/v1/operations/compliance/export?${range}`;
}

const TONE: Record<CliRatio['level'], 'ok' | 'warn' | 'danger'> = {
  ok: 'ok',
  warn: 'warn',
  stop: 'danger',
};

/**
 * Abandoned and silent call ratios per caller number over the last 24 hours (telco detection
 * criteria: 3% and 1%), and the regulator export.
 */
export function ComplianceEvidencePanel({
  ratios,
  canExport,
}: {
  ratios: CliRatio[];
  canExport: boolean;
}) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const worst = ratios.reduce((max, row) => Math.max(max, row.abandonedRatio), 0);
  const worstLevel = ratios.find((row) => row.abandonedRatio === worst)?.level ?? 'ok';

  const columns: ColumnV2<CliRatio>[] = [
    {
      id: 'fromNumber',
      header: 'Caller number',
      cell: (row) => <span className="mono">{row.fromNumber}</span>,
    },
    {
      id: 'attempts',
      header: 'Attempts',
      cell: (row) => row.attempts,
      sortValue: (row) => row.attempts,
    },
    {
      id: 'abandoned',
      header: 'Abandoned',
      cell: (row) => (
        <StatusBadgeV2 tone={TONE[row.level]} label={formatPercent(row.abandonedRatio)} />
      ),
      sortValue: (row) => row.abandonedRatio,
    },
    { id: 'silent', header: 'Silent', cell: (row) => formatPercent(row.silentRatio) },
  ];

  return (
    <div className="stack">
      {ratios.length > 0 && (
        <ProgressMeter
          label="Worst abandoned ratio vs the 3% breaker"
          value={worst * 100}
          max={3}
          threshold={3}
          tone={TONE[worstLevel]}
          valueLabel={formatPercent(worst)}
        />
      )}
      {!ratios.length ? (
        <EmptyStateV2 title="No calls in the last 24 hours">
          Ratios appear after the first dials.
        </EmptyStateV2>
      ) : (
        <DataTableV2
          label="Abandoned and silent ratios"
          rows={ratios}
          columns={columns}
          rowKey={(row) => row.fromNumber}
        />
      )}
      {canExport && (
        <div className="form-grid">
          <FormField id="export-from" label="From">
            {(control) => (
              <input
                {...control}
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            )}
          </FormField>
          <FormField id="export-to" label="To (inclusive)">
            {(control) => (
              <input
                {...control}
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            )}
          </FormField>
          <a className="button primary align-start" href={exportHref(from, to)} download>
            Download regulator export
          </a>
        </div>
      )}
    </div>
  );
}
