'use client';
import { useState } from 'react';
import { EmptyState, Field, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';
import type { CliRatio } from './compliance-types';

const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
const today = () => new Date().toISOString().slice(0, 10);

/** The regulator export link for a date range, in UTC days. */
export function exportHref(from: string, to: string): string {
  const range = new URLSearchParams({
    from: new Date(`${from}T00:00:00Z`).toISOString(),
    to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(),
  });
  return `/api/v1/operations/compliance/export?${range}`;
}

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
  return (
    <Panel labelledBy="evidence-title">
      <PanelHeader id="evidence-title" title="Call ratios and regulator export" />
      {!ratios.length ? (
        <div className="panel-body">
          <EmptyState title="No calls in the last 24 hours">
            Ratios appear after the first dials.
          </EmptyState>
        </div>
      ) : (
        <ResponsiveTable label="Abandoned and silent ratios">
          <thead>
            <tr>
              <th>Caller number</th>
              <th>Attempts</th>
              <th>Abandoned</th>
              <th>Silent</th>
            </tr>
          </thead>
          <tbody>
            {ratios.map((row) => (
              <tr key={row.fromNumber}>
                <td className="mono">{row.fromNumber}</td>
                <td>{row.attempts}</td>
                <td>
                  <StatusBadge
                    tone={
                      row.level === 'stop' ? 'danger' : row.level === 'warn' ? 'warning' : 'good'
                    }
                  >
                    {percent(row.abandonedRatio)}
                  </StatusBadge>
                </td>
                <td>{percent(row.silentRatio)}</td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      )}
      {canExport && (
        <div className="panel-body form-grid">
          <Field label="From" htmlFor="export-from">
            <input
              id="export-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="To (inclusive)" htmlFor="export-to">
            <input
              id="export-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <a className="button align-start" href={exportHref(from, to)} download>
            Download regulator export
          </a>
        </div>
      )}
    </Panel>
  );
}
