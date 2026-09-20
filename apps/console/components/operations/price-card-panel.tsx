'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type { PriceCardVersion } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

export function PriceCardPanel({ role }: { role: SessionIdentity['role'] }) {
  const [cards, setCards] = useState<PriceCardVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setCards(
        items<PriceCardVersion>((await apiRequest<unknown>('/cost/price-cards?limit=100')).data),
      );
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Price cards could not be loaded.');
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
      await apiRequest('/cost/price-cards', {
        method: 'POST',
        body: JSON.stringify({
          id: values.get('id'),
          version: values.get('version'),
          provider: values.get('provider'),
          unit: values.get('unit'),
          currency: values.get('currency'),
          minorUnitsPerBlock: values.get('minorUnitsPerBlock'),
          blockQuantity: values.get('blockQuantity'),
          effectiveAt: new Date(String(values.get('effectiveAt'))).toISOString(),
          provenance: values.get('provenance'),
        }),
      });
      form.reset();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Price card could not be stored.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel labelledBy="price-cards-title">
      <PanelHeader
        id="price-cards-title"
        title="Immutable price cards"
        badge={<StatusBadge tone="soft">{cards.length} versions</StatusBadge>}
      />
      <div className="panel-body stack">
        <p className="muted">
          Native provider units are priced against immutable card IDs and versions. Existing
          versions cannot be overwritten with different economics.
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        {role === 'admin' && (
          <form className="nested-card stack" onSubmit={save}>
            <h4>Add immutable card version</h4>
            <div className="form-grid">
              <Field label="Card ID" htmlFor="card-id">
                <input id="card-id" name="id" required />
              </Field>
              <Field label="Version" htmlFor="card-version">
                <input id="card-version" name="version" required />
              </Field>
              <Field label="Provider" htmlFor="card-provider">
                <input id="card-provider" name="provider" required />
              </Field>
              <Field label="Native unit" htmlFor="card-unit">
                <input id="card-unit" name="unit" placeholder="audio_seconds" required />
              </Field>
              <Field label="Currency" htmlFor="card-currency">
                <input
                  id="card-currency"
                  name="currency"
                  defaultValue="INR"
                  pattern="[A-Z]{3}"
                  required
                />
              </Field>
              <Field label="Minor units per block" htmlFor="card-amount">
                <input id="card-amount" name="minorUnitsPerBlock" inputMode="decimal" required />
              </Field>
              <Field label="Block quantity" htmlFor="card-block">
                <input id="card-block" name="blockQuantity" inputMode="decimal" required />
              </Field>
              <Field label="Effective at" htmlFor="card-effective">
                <input id="card-effective" name="effectiveAt" type="datetime-local" required />
              </Field>
              <Field
                label="Provenance"
                htmlFor="card-provenance"
                help="Invoice, contract, or operator evidence for this rate."
              >
                <textarea id="card-provenance" name="provenance" required />
              </Field>
            </div>
            <button className="button primary align-start" disabled={busy}>
              Store immutable card
            </button>
          </form>
        )}
        {cards.length === 0 ? (
          <EmptyState title="No price cards">
            Provider usage cannot be priced until an admin records an immutable card version.
          </EmptyState>
        ) : (
          <ResponsiveTable label="Immutable price cards">
            <thead>
              <tr>
                <th>Card</th>
                <th>Provider/unit</th>
                <th>Price</th>
                <th>Effective</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={`${card.id}:${card.version}`}>
                  <td>
                    <strong>{card.id}</strong>
                    <small>{card.version}</small>
                  </td>
                  <td>
                    {card.provider}
                    <small>{card.unit}</small>
                  </td>
                  <td>
                    {card.minorUnitsPerBlock} {card.currency} minor / {card.blockQuantity}
                  </td>
                  <td>{new Date(card.effectiveAt).toLocaleString()}</td>
                  <td>{card.provenance}</td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </div>
    </Panel>
  );
}
