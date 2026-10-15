'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { costByProvider, type CostEvidence, type CostLine } from '../../lib/derive/call-detail';
import { InlineAlert, Skeleton } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { ProgressMeter } from '../charts/meter';
import { ChartFrame } from '../charts/chart-frame';
import { Donut } from '../charts/donut';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { formatMoney, formatQuantity } from '../../lib/format';
import { Money } from '../ui/display';

export type { CostEvidence };

interface LedgerCost {
  provisional: boolean;
  provisionalPriceCards: { id: string; version: string }[];
}

const LINE_PAGE = 50;

/**
 * The Cost tab: per-currency estimated/reconciled KPIs with a spend meter, a provider donut per
 * currency, and the full cost-line table — Money/formatQuantity everywhere instead of raw minor
 * units and snake_case unit keys (brief defect #18).
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
  const currencies = cost?.currencies ?? [];
  const lines = cost?.lines ?? [];
  const columns: ColumnV2<CostLine>[] = [
    {
      id: 'provider',
      header: 'Provider',
      cell: (line) => line.provider,
      sortValue: (line) => line.provider,
    },
    {
      id: 'quantity',
      header: 'Quantity',
      cell: (line) => formatQuantity(Number(line.quantity), line.unit),
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'end',
      cell: (line) => <Money minorUnits={line.amountMinor} currency={line.currency} />,
      sortValue: (line) => Number(line.amountMinor),
    },
    {
      id: 'state',
      header: 'State',
      // `lib/status.ts`'s shared tone map has no entry for the ledger's own "reconciled"/
      // "estimated" vocabulary (it falls back to neutral grey for both, indistinguishable) — an
      // explicit tone here reads better than two identical badges.
      cell: (line) => (
        <StatusBadgeV2 value={line.state} tone={line.state === 'reconciled' ? 'ok' : 'info'} />
      ),
    },
    {
      id: 'price-card',
      header: 'Price card',
      priority: 'low',
      cell: (line) => (
        <span className="mono" title={`${line.priceCardId}@${line.priceCardVersion}`}>
          {line.priceCardId}
        </span>
      ),
    },
  ];
  return (
    <div className="ds-stack">
      {currencies.length === 0 && <p className="muted">No priced usage recorded.</p>}
      <KpiStrip>
        {currencies.map((total) => (
          <KpiCard
            key={total.currency}
            label={`Total (${total.currency})`}
            value={
              <Money
                minorUnits={Number(total.estimatedMinor) + Number(total.reconciledMinor)}
                currency={total.currency}
              />
            }
            footnote={`${total.lines} lines`}
          />
        ))}
      </KpiStrip>
      {currencies.map((total) => (
        <ProgressMeter
          key={total.currency}
          label={`${total.currency} spend`}
          max={Math.max(1, Number(total.estimatedMinor) + Number(total.reconciledMinor))}
          segments={[
            { label: 'Reconciled', value: Number(total.reconciledMinor), tone: 'ok' },
            { label: 'Estimated', value: Number(total.estimatedMinor), tone: 'info' },
          ]}
          valueLabel={`${formatMoney(total.reconciledMinor, total.currency)} reconciled · ${formatMoney(total.estimatedMinor, total.currency)} estimated`}
        />
      ))}
      {ledger === undefined && <Skeleton shape="line" width="60%" />}
      {ledger?.provisional && (
        <InlineAlert tone="warn">
          Provisional: priced partly from placeholder price cards (
          {ledger.provisionalPriceCards.map((card) => `${card.id}@${card.version}`).join(', ')}).
        </InlineAlert>
      )}
      {(cost?.unpriced ?? []).length > 0 && (
        <InlineAlert tone="warn">Unpriced meters: {cost!.unpriced!.join(', ')}</InlineAlert>
      )}
      <div className="ui-grid">
        {currencies.map((total) => {
          const slices = costByProvider(lines, total.currency);
          return (
            <ChartFrame
              key={total.currency}
              title={`Cost by provider (${total.currency})`}
              ariaLabel={`Cost by provider in ${total.currency}`}
              height={200}
              empty={!slices.length}
              tableRows={slices.length}
              tableColumns={[
                { header: 'Provider', cell: (i) => slices[i]!.label },
                { header: 'Amount', cell: (i) => formatMoney(slices[i]!.value, total.currency) },
              ]}
              renderChart={() => (
                <Donut
                  slices={slices}
                  // M2: the reconciled amount alone read as the "total" next to a bigger slice
                  // sum ($0.03 centre against a $0.06 ring) — the centre is the same
                  // estimated+reconciled total the slices themselves add up to.
                  centerLabel={formatMoney(
                    Number(total.estimatedMinor) + Number(total.reconciledMinor),
                    total.currency,
                  )}
                  formatValue={(value) => formatMoney(value, total.currency)}
                />
              )}
            />
          );
        })}
      </div>
      {lines.length > 0 && (
        <DataTableV2
          key={dataTableRenderKey(false, undefined, lines.length)}
          label="Cost lines"
          rows={lines.slice(0, shown)}
          rowKey={(line) => line.id}
          columns={columns}
        />
      )}
      {shown < lines.length && (
        <button type="button" className="button small" onClick={() => setShown(shown + LINE_PAGE)}>
          Show more lines
        </button>
      )}
    </div>
  );
}
