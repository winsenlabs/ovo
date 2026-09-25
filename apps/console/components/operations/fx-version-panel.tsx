'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type { FxVersion } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

export function FxVersionPanel({ role }: { role: SessionIdentity['role'] }) {
  const [versions, setVersions] = useState<FxVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setVersions(
        items<FxVersion>((await apiRequest<unknown>('/cost/fx-versions?limit=100')).data),
      );
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'FX versions could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(undefined);
    try {
      await apiRequest('/cost/fx-versions', {
        method: 'POST',
        body: JSON.stringify({
          id: values.get('id'),
          version: values.get('version'),
          baseCurrency: values.get('baseCurrency'),
          quoteCurrency: 'INR',
          rateNumerator: values.get('rateNumerator'),
          rateDenominator: values.get('rateDenominator'),
          effectiveAt: new Date(String(values.get('effectiveAt'))).toISOString(),
          provenance: values.get('provenance'),
        }),
      });
      form.reset();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'FX version could not be stored.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel labelledBy="fx-versions-title">
      <PanelHeader
        id="fx-versions-title"
        title="Immutable FX versions"
        badge={<StatusBadge tone="soft">{versions.length} versions</StatusBadge>}
      />
      <div className="panel-body stack">
        <p className="muted">
          Non-INR charges require an immutable rational conversion into INR. Floating-point rates
          are not accepted.
        </p>
        {error && <div className="field-error" role="alert">{error}</div>}
        {role === 'admin' && (
          <form className="nested-card stack" onSubmit={save}>
            <h4>Add immutable FX version</h4>
            <div className="form-grid">
              <Field label="FX ID" htmlFor="fx-id">
                <input id="fx-id" name="id" required />
              </Field>
              <Field label="Version" htmlFor="fx-version">
                <input id="fx-version" name="version" required />
              </Field>
              <Field label="Base currency" htmlFor="fx-base">
                <input
                  id="fx-base"
                  name="baseCurrency"
                  pattern="[A-Z]{3}"
                  placeholder="USD"
                  required
                />
              </Field>
              <Field label="Quote currency" htmlFor="fx-quote">
                <input id="fx-quote" value="INR" readOnly />
              </Field>
              <Field label="Rate numerator" htmlFor="fx-numerator">
                <input id="fx-numerator" name="rateNumerator" inputMode="numeric" required />
              </Field>
              <Field label="Rate denominator" htmlFor="fx-denominator">
                <input id="fx-denominator" name="rateDenominator" inputMode="numeric" required />
              </Field>
              <Field label="Effective at" htmlFor="fx-effective">
                <input id="fx-effective" name="effectiveAt" type="datetime-local" required />
              </Field>
              <Field label="Provenance" htmlFor="fx-provenance">
                <textarea id="fx-provenance" name="provenance" required />
              </Field>
            </div>
            <button className="button primary align-start" disabled={busy}>
              Store immutable FX version
            </button>
          </form>
        )}
        {versions.length === 0 ? (
          <EmptyState title="No FX versions">
            INR price cards need no FX record. Foreign-currency cards do.
          </EmptyState>
        ) : (
          <ResponsiveTable label="Immutable FX versions">
            <thead>
              <tr>
                <th>FX</th>
                <th>Pair</th>
                <th>Exact rate</th>
                <th>Effective</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((fx) => (
                <tr key={`${fx.id}:${fx.version}`}>
                  <td>
                    <strong>{fx.id}</strong>
                    <small>{fx.version}</small>
                  </td>
                  <td>
                    {fx.baseCurrency}/{fx.quoteCurrency}
                  </td>
                  <td>
                    {fx.rateNumerator} / {fx.rateDenominator}
                  </td>
                  <td>{new Date(fx.effectiveAt).toLocaleString()}</td>
                  <td>{fx.provenance}</td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </div>
    </Panel>
  );
}
