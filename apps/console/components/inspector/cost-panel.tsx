'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { Callout } from '../ui/feedback';

export interface CostEvidence {
  unpriced?: string[];
  currencies?: {
    currency: string;
    estimatedMinor: string;
    reconciledMinor: string;
    lines: number;
  }[];
  lines?: {
    id: string;
    provider: string;
    quantity: string;
    unit: string;
    amountMinor: string;
    currency: string;
    state: string;
    priceCardId: string;
    priceCardVersion: string;
  }[];
}

interface LedgerCost {
  provisional: boolean;
  provisionalPriceCards: { id: string; version: string }[];
}

const LINE_PAGE = 50;

/** Minor units in their own currency; an unknown currency code is shown as its code. */
export function money(minor: string, currency: string): string {
  const value = Number(minor);
  if (!Number.isSafeInteger(value)) return `${minor} ${currency} (minor units)`;
  try {
    const format = new Intl.NumberFormat('en-IN', { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(value / 10 ** digits);
  } catch {
    return `${value} ${currency} (minor units)`;
  }
}

/**
 * OBS-7: the call's cost lines in every currency, not only rupees, with unpriced meters and any
 * total priced from a placeholder (provisional) price card called out.
 */
export function CostPanel({ callId, cost }: { callId: string; cost?: CostEvidence }) {
  const [ledger, setLedger] = useState<LedgerCost | null>();
  const [shown, setShown] = useState(LINE_PAGE);
  useEffect(() => {
    void apiRequest<LedgerCost>(`/calls/${encodeURIComponent(callId)}/cost`)
      .then(({ data }) => setLedger(data))
      // No cost ledger on this installation: the lines below are still the call's usage.
      .catch(() => setLedger(null));
  }, [callId]);
  const lines = cost?.lines ?? [];
  return (
    <div className="ui-stack">
      {(cost?.currencies ?? []).length === 0 && <p>No priced usage recorded.</p>}
      <dl aria-label="Cost totals">
        {(cost?.currencies ?? []).map((total) => (
          <div key={total.currency}>
            <dt>{total.currency}</dt>
            <dd>
              {money(total.estimatedMinor, total.currency)} estimated ·{' '}
              {money(total.reconciledMinor, total.currency)} reconciled · {total.lines} lines
            </dd>
          </div>
        ))}
      </dl>
      {ledger?.provisional && (
        <Callout tone="warning">
          Provisional: priced partly from placeholder price cards (
          {ledger.provisionalPriceCards.map((card) => `${card.id}@${card.version}`).join(', ')}).
        </Callout>
      )}
      {(cost?.unpriced ?? []).length > 0 && (
        <Callout tone="warning">Unpriced meters: {cost!.unpriced!.join(', ')}</Callout>
      )}
      {lines.length > 0 && (
        <table aria-label="Cost lines">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Quantity</th>
              <th>Amount</th>
              <th>State</th>
              <th>Price card</th>
            </tr>
          </thead>
          <tbody>
            {lines.slice(0, shown).map((line) => (
              <tr key={line.id}>
                <td>{line.provider}</td>
                <td>
                  {line.quantity} {line.unit}
                </td>
                <td>{money(line.amountMinor, line.currency)}</td>
                <td>{line.state}</td>
                <td className="mono">
                  {line.priceCardId}@{line.priceCardVersion}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown < lines.length && (
        <button className="button small" onClick={() => setShown(shown + LINE_PAGE)}>
          Show more lines
        </button>
      )}
    </div>
  );
}
