'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { ResponsiveTable, StatusBadge } from '../primitives';

export interface RequiredMeter {
  key: string;
  unit: string;
  label: string;
  slot: string;
  model?: string;
  status:
    | 'covered'
    | 'missing'
    | 'price_card_unavailable'
    | 'price_unknown_for_model'
    | 'unit_mismatch'
    | 'fx_missing';
  reference?: { id: string; version: string };
  card?: { provisional?: boolean; model?: string };
  catalog: { id: string; version: string; model?: string; provisional: boolean }[];
}
interface Checklist {
  draftVersion: number;
  complete: boolean;
  provisional: boolean;
  meters: RequiredMeter[];
}

const STATUS: Record<RequiredMeter['status'], string> = {
  covered: 'Priced',
  missing: 'No price card',
  price_card_unavailable: 'Card version not stored',
  price_unknown_for_model: 'Card prices another model',
  unit_mismatch: 'Card provider or unit differs',
  fx_missing: 'FX version missing',
};

/**
 * OPS-14: the meters the saved draft's providers will emit, derived by the API instead of typed
 * by hand, with what each price reference still needs. `onUse` fills a reference in the editor.
 */
export function RequiredMeters({
  agentId,
  onUse,
}: {
  agentId: string;
  onUse: (meterKey: string, reference: { id: string; version: string }) => void;
}) {
  const [checklist, setChecklist] = useState<Checklist>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setChecklist(
        (await apiRequest<Checklist>(`/agents/${encodeURIComponent(agentId)}/required-meters`))
          .data,
      );
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Required meters are unavailable.');
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return (
      <div className="field-error" role="alert">
        {error}
      </div>
    );
  if (!checklist) return null;
  return (
    <section aria-label="Required meter checklist" className="stack">
      <div className="button-row">
        <StatusBadge tone={checklist.complete ? 'good' : 'warning'}>
          {checklist.complete ? 'Every meter is priced' : 'Meters need prices'}
        </StatusBadge>
        {checklist.provisional && (
          <StatusBadge tone="warning">Uses a provisional price</StatusBadge>
        )}
        <span className="muted">Checked against saved draft v{checklist.draftVersion}.</span>
        <button className="text-button" type="button" onClick={() => void load()}>
          Recheck
        </button>
      </div>
      <ResponsiveTable label="Required meters">
        <thead>
          <tr>
            <th>Meter</th>
            <th>Model</th>
            <th>Status</th>
            <th>Catalog price</th>
          </tr>
        </thead>
        <tbody>
          {checklist.meters.map((meter) => (
            <tr key={meter.key}>
              <td>
                <strong>{meter.label}</strong>
                <small>{meter.key}</small>
              </td>
              <td>{meter.model ?? '—'}</td>
              <td>
                <StatusBadge tone={meter.status === 'covered' ? 'good' : 'warning'}>
                  {STATUS[meter.status]}
                </StatusBadge>
                {meter.card?.provisional && <small>Provisional price</small>}
              </td>
              <td>
                {meter.catalog.length === 0
                  ? 'No catalog price for this model'
                  : meter.catalog.map((entry) => (
                      <button
                        key={`${entry.id}:${entry.version}`}
                        className="text-button"
                        type="button"
                        aria-label={`Use ${entry.id} for ${meter.key}`}
                        onClick={() => onUse(meter.key, { id: entry.id, version: entry.version })}
                      >
                        Use {entry.id} {entry.version}
                        {entry.provisional ? ' (provisional)' : ''}
                      </button>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
      <p className="muted">
        A catalog price must be imported on the Cost page before a call can use it.
      </p>
    </section>
  );
}
