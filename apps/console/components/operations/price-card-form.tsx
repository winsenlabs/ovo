'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import type { PluginCatalog } from '../plugins/types';

type Meter = { key: string; label: string; provider: string; unit: string };

/** The "Add immutable card version" drawer form, extracted so `PriceCardPanel` stays under the
 * module-size gate. Provider and native unit are read-only, derived from the chosen meter. */
export function PriceCardForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [meters, setMeters] = useState<Meter[]>([]);
  const [meterKey, setMeterKey] = useState('');
  useEffect(() => {
    void apiRequest<PluginCatalog>('/plugins').then(({ data }) =>
      setMeters(
        data.plugins.flatMap((plugin) =>
          (plugin.meters ?? []).map((meter) => ({
            key: meter.key,
            label: meter.label,
            provider: plugin.provider ?? plugin.id,
            unit: meter.unit,
          })),
        ),
      ),
    );
  }, []);
  const selectedMeter = meters.find((meter) => meter.key === meterKey);

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="card-meter">Manifest meter key</label>
        <select
          id="card-meter"
          value={meterKey}
          onChange={(event) => setMeterKey(event.target.value)}
          required
        >
          <option value="">Select meter</option>
          {meters.map((meter) => (
            <option key={meter.key} value={meter.key}>
              {meter.label} · {meter.key}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="card-id">Card ID</label>
        <input id="card-id" name="id" required />
      </div>
      <div className="field">
        <label htmlFor="card-version">Version</label>
        <input id="card-version" name="version" required />
      </div>
      <div className="field">
        <label htmlFor="card-provider">Provider</label>
        <input
          id="card-provider"
          name="provider"
          value={selectedMeter?.provider ?? ''}
          readOnly
          required
        />
      </div>
      <div className="field">
        <label htmlFor="card-unit">Native unit</label>
        <input id="card-unit" name="unit" value={selectedMeter?.unit ?? ''} readOnly required />
      </div>
      <div className="field">
        <label htmlFor="card-currency">Currency</label>
        <input id="card-currency" name="currency" defaultValue="INR" pattern="[A-Z]{3}" required />
      </div>
      <div className="field">
        <label htmlFor="card-amount">Minor units per block</label>
        <input id="card-amount" name="minorUnitsPerBlock" inputMode="decimal" required />
      </div>
      <div className="field">
        <label htmlFor="card-block">Block quantity</label>
        <input id="card-block" name="blockQuantity" inputMode="decimal" required />
      </div>
      <div className="field">
        <label htmlFor="card-effective">Effective at</label>
        <input id="card-effective" name="effectiveAt" type="datetime-local" required />
      </div>
      <div className="field">
        <label htmlFor="card-model">Model</label>
        <input id="card-model" name="model" placeholder="e.g. gpt-6-luna" />
        <small>The model or SKU this price applies to. Leave empty to cover every model.</small>
      </div>
      <div className="field">
        <label htmlFor="card-provisional">
          <input id="card-provisional" name="provisional" type="checkbox" /> Provisional price
        </label>
        <small>
          A placeholder or unverified rate. Call costs priced with it are labelled provisional.
        </small>
      </div>
      <div className="field">
        <label htmlFor="card-provenance">Provenance</label>
        <textarea id="card-provenance" name="provenance" required />
        <small>Invoice, contract, or operator evidence for this rate.</small>
      </div>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? 'Storing…' : 'Store immutable card'}
      </button>
    </form>
  );
}
