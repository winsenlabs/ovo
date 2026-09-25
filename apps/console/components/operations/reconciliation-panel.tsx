'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { ReconciliationResult } from '../../lib/operator-api';
import { Field, JsonEvidence, Panel, PanelHeader, StatusBadge } from '../primitives';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `reconciliation-${Date.now()}`;

export function ReconciliationPanel({ role }: { role: SessionIdentity['role'] }) {
  const [currency, setCurrency] = useState('INR');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [result, setResult] = useState<ReconciliationResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (role !== 'admin') return null;

  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const { data } = await apiRequest<ReconciliationResult>('/cost/reconciliation', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey,
          usageId: values.get('usageId'),
          providerInvoiceId: values.get('providerInvoiceId'),
          providerInvoiceLineId: values.get('providerInvoiceLineId'),
          actualAmountMinor: values.get('actualAmountMinor'),
          currency,
          ...(currency === 'INR'
            ? {}
            : { fx: { id: values.get('fxId'), version: values.get('fxVersion') } }),
          occurredAt: new Date(String(values.get('occurredAt'))).toISOString(),
        }),
      });
      setResult(data);
      setIdempotencyKey(newKey());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Invoice reconciliation failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel labelledBy="reconciliation-title">
      <PanelHeader
        id="reconciliation-title"
        title="Provider invoice reconciliation"
        badge={<StatusBadge tone="warning">Append-only correction</StatusBadge>}
      />
      <form className="panel-body stack" onSubmit={reconcile}>
        <div className="muted">
          Reconciliation never rewrites recorded native usage. It appends a signed correction delta
          linked to one provider invoice line and updates the associated budget when applicable.
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          <Field label="Usage ID" htmlFor="reconcile-usage">
            <input id="reconcile-usage" name="usageId" required />
          </Field>
          <Field label="Provider invoice ID" htmlFor="reconcile-invoice">
            <input id="reconcile-invoice" name="providerInvoiceId" required />
          </Field>
          <Field label="Invoice line ID" htmlFor="reconcile-line">
            <input id="reconcile-line" name="providerInvoiceLineId" required />
          </Field>
          <Field label="Actual amount (minor units)" htmlFor="reconcile-amount">
            <input id="reconcile-amount" name="actualAmountMinor" inputMode="numeric" required />
          </Field>
          <Field label="Currency" htmlFor="reconcile-currency">
            <input
              id="reconcile-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              pattern="[A-Z]{3}"
              required
            />
          </Field>
          <Field label="Occurred at" htmlFor="reconcile-occurred">
            <input id="reconcile-occurred" name="occurredAt" type="datetime-local" required />
          </Field>
          {currency !== 'INR' && (
            <>
              <Field label="FX ID" htmlFor="reconcile-fx-id">
                <input id="reconcile-fx-id" name="fxId" required />
              </Field>
              <Field label="FX version" htmlFor="reconcile-fx-version">
                <input id="reconcile-fx-version" name="fxVersion" required />
              </Field>
            </>
          )}
          <Field
            label="Idempotency key"
            htmlFor="reconcile-key"
            help="Reuse this exact key only when retrying the same invoice line."
          >
            <input
              id="reconcile-key"
              className="mono"
              value={idempotencyKey}
              onChange={(event) => setIdempotencyKey(event.target.value)}
              required
            />
          </Field>
        </div>
        <button className="button primary align-start" disabled={busy}>
          {busy ? 'Reconciling…' : 'Append reconciliation'}
        </button>
        {result && <JsonEvidence label="Reconciliation receipt" value={result} />}
      </form>
    </Panel>
  );
}
