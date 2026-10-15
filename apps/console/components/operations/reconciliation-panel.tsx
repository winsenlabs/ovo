'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { ReconciliationResult } from '../../lib/operator-api';
import { formatMoney } from '../../lib/format';
import { SectionCard, KeyValueGrid } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `reconciliation-${Date.now()}`;

/** One admin-only correction form per invoice line, with the receipt shown as a KeyValueGrid
 * instead of a raw JSON dump. Reconciliation never rewrites recorded native usage. */
export function ReconciliationPanel({ role }: { role: SessionIdentity['role'] }) {
  const [currency, setCurrency] = useState('INR');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [result, setResult] = useState<ReconciliationResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (role !== 'admin')
    return (
      <SectionCard title="Provider invoice reconciliation">
        <p className="muted">Invoice reconciliation is restricted to administrators.</p>
      </SectionCard>
    );

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
    <SectionCard
      title="Provider invoice reconciliation"
      description="Appends a signed correction delta linked to one provider invoice line and updates the associated budget when applicable. It never rewrites recorded native usage."
      padding="prose"
    >
      <form className="stack" onSubmit={reconcile}>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="reconcile-usage">Usage ID</label>
            <input id="reconcile-usage" name="usageId" required />
          </div>
          <div className="field">
            <label htmlFor="reconcile-invoice">Provider invoice ID</label>
            <input id="reconcile-invoice" name="providerInvoiceId" required />
          </div>
          <div className="field">
            <label htmlFor="reconcile-line">Invoice line ID</label>
            <input id="reconcile-line" name="providerInvoiceLineId" required />
          </div>
          <div className="field">
            <label htmlFor="reconcile-amount">Actual amount (minor units)</label>
            <input id="reconcile-amount" name="actualAmountMinor" inputMode="numeric" required />
          </div>
          <div className="field">
            <label htmlFor="reconcile-currency">Currency</label>
            <input
              id="reconcile-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              pattern="[A-Z]{3}"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="reconcile-occurred">Occurred at</label>
            <input id="reconcile-occurred" name="occurredAt" type="datetime-local" required />
          </div>
          {currency !== 'INR' && (
            <>
              <div className="field">
                <label htmlFor="reconcile-fx-id">FX ID</label>
                <input id="reconcile-fx-id" name="fxId" required />
              </div>
              <div className="field">
                <label htmlFor="reconcile-fx-version">FX version</label>
                <input id="reconcile-fx-version" name="fxVersion" required />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="reconcile-key">Idempotency key</label>
            <input
              id="reconcile-key"
              className="mono"
              value={idempotencyKey}
              onChange={(event) => setIdempotencyKey(event.target.value)}
              required
            />
            <small>Reuse this exact key only when retrying the same invoice line.</small>
          </div>
        </div>
        <button className="button primary align-start" disabled={busy}>
          {busy ? 'Reconciling…' : 'Append reconciliation'}
        </button>
      </form>
      {result && (
        <div className="ds-stack" style={{ marginTop: 'var(--space-4)' }}>
          <h3>Reconciliation receipt</h3>
          <KeyValueGrid
            columns={3}
            items={[
              { label: 'Usage', value: result.usageId, mono: true, copy: result.usageId },
              {
                label: 'Correction',
                value: result.correctionId,
                mono: true,
                copy: result.correctionId,
              },
              { label: 'Delta', value: formatMoney(result.deltaPaise) },
              { label: 'Effective amount', value: formatMoney(result.effectiveAmountPaise) },
              { label: 'State', value: <StatusBadgeV2 value={result.state} /> },
            ]}
          />
        </div>
      )}
    </SectionCard>
  );
}
