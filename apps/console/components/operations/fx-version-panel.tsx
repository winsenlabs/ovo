'use client';
import { useMemo, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { FxVersion } from '../../lib/operator-api';
import { formatDateTime } from '../../lib/format';
import { SectionCard } from '../ui/section-card';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import { ChartFrame } from '../charts/chart-frame';
import { LineChart, type LineSeries } from '../charts/line-chart';
import { useListResource } from './use-list-resource';
import { useDrawerForm } from './use-drawer-form';

function rateSeries(versions: readonly FxVersion[]): LineSeries[] {
  const byPair = new Map<string, { x: number; y: number }[]>();
  for (const fx of versions) {
    const rate = Number(fx.rateNumerator) / Number(fx.rateDenominator);
    if (!Number.isFinite(rate)) continue;
    const key = `${fx.baseCurrency}/${fx.quoteCurrency}`;
    const points = byPair.get(key) ?? [];
    points.push({ x: new Date(fx.effectiveAt).getTime(), y: rate });
    byPair.set(key, points);
  }
  return [...byPair.entries()].map(([key, points]) => ({
    key,
    label: key,
    points: points.sort((a, b) => a.x - b.x),
  }));
}

/**
 * The shared `LineChart` always domains its y-axis from 0 (right for latency/counts), which
 * flattens an FX rate series into a line pinned at the top: USD/INR moves inside a band of a few
 * rupees around 84, not 0–84. Rebasing each pair to "% vs its first version" uses the chart's
 * full height to show the real drift; the table view (built from the untouched `rateSeries`)
 * keeps the exact absolute rate.
 */
function driftSeries(series: readonly LineSeries[]): LineSeries[] {
  return series.map((item) => {
    const base = item.points[0]?.y;
    return {
      ...item,
      points: item.points.map((point) => ({
        x: point.x,
        y: base ? ((point.y - base) / base) * 100 : 0,
      })),
    };
  });
}

/**
 * Immutable FX versions, with a line chart of the rate over time per currency pair above the
 * table — previously the only view was a raw numerator/denominator table with no sense of drift.
 */
export function FxVersionPanel({ role }: { role: SessionIdentity['role'] }) {
  const {
    data: versions,
    error: loadError,
    reload: load,
  } = useListResource<FxVersion>('/cost/fx-versions?limit=100');
  const drawer = useDrawerForm(load);
  const save = (event: FormEvent<HTMLFormElement>) =>
    drawer.submit(
      event,
      (values) =>
        apiRequest('/cost/fx-versions', {
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
        }).then(() => undefined),
      'FX version could not be stored.',
    );

  const series = useMemo(() => rateSeries(versions ?? []), [versions]);
  const chartSeries = useMemo(() => driftSeries(series), [series]);

  const columns: ColumnV2<FxVersion>[] = [
    {
      id: 'fx',
      header: 'FX',
      cell: (fx) => (
        <>
          <strong>{fx.id}</strong>
          <br />
          <small className="mono muted">{fx.version}</small>
        </>
      ),
      sortValue: (fx) => fx.id,
    },
    { id: 'pair', header: 'Pair', cell: (fx) => `${fx.baseCurrency}/${fx.quoteCurrency}` },
    {
      id: 'rate',
      header: 'Exact rate',
      cell: (fx) => (
        <span className="mono">
          {fx.rateNumerator} / {fx.rateDenominator}
        </span>
      ),
      align: 'end',
    },
    {
      id: 'effective',
      header: 'Effective',
      cell: (fx) => formatDateTime(fx.effectiveAt),
      sortValue: (fx) => fx.effectiveAt,
    },
    { id: 'provenance', header: 'Provenance', cell: (fx) => fx.provenance, priority: 'low' },
  ];

  return (
    <div className="ds-stack">
      <SectionCard
        title="FX rate drift"
        description="% change vs each pair's first stored rate. Exact rates are in the table view."
      >
        <ChartFrame
          ariaLabel="FX rate drift over time by currency pair, as a percentage of the first stored rate"
          loading={versions === null}
          error={loadError}
          onRetry={load}
          empty={versions !== null && series.length === 0}
          emptyLabel="No FX versions recorded"
          tableRows={series.flatMap((s) => s.points).length}
          tableColumns={[
            { header: 'Pair', cell: (i) => flatRow(series, i)?.label },
            { header: 'At', cell: (i) => formatDateTime(flatRow(series, i)?.point.x) },
            { header: 'Rate', cell: (i) => flatRow(series, i)?.point.y.toFixed(4) },
          ]}
          renderChart={(width) => (
            <LineChart
              series={chartSeries}
              width={width}
              xScale="time"
              xFormat={(value) =>
                formatDateTime(value, { dateStyle: 'short', timeStyle: undefined })
              }
              yFormat={(value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`}
            />
          )}
        />
      </SectionCard>
      <SectionCard
        title="Immutable FX versions"
        description="Non-INR charges require an immutable rational conversion into INR. Floating-point rates are not accepted."
        padding="flush"
        actions={
          role === 'admin' ? (
            <Button variant="primary" type="button" onClick={() => drawer.setOpen(true)}>
              Add FX version
            </Button>
          ) : undefined
        }
      >
        <DataTableV2
          // See price-catalog-panel.tsx: remounts across the loading → loaded boundary to avoid
          // DataTableV2's hook-count mismatch (foundation request in the build report).
          key={versions === null ? 'loading' : 'loaded'}
          label="Immutable FX versions"
          rows={versions ?? []}
          loading={versions === null}
          error={loadError}
          onRetry={load}
          columns={columns}
          rowKey={(fx) => `${fx.id}:${fx.version}`}
          empty="INR price cards need no FX record. Foreign-currency cards do."
        />
      </SectionCard>
      {role === 'admin' && (
        <Drawer
          open={drawer.open}
          title="Add immutable FX version"
          onClose={() => drawer.setOpen(false)}
        >
          <form className="stack" onSubmit={save}>
            <div className="field">
              <label htmlFor="fx-id">FX ID</label>
              <input id="fx-id" name="id" required />
            </div>
            <div className="field">
              <label htmlFor="fx-version">Version</label>
              <input id="fx-version" name="version" required />
            </div>
            <div className="field">
              <label htmlFor="fx-base">Base currency</label>
              <input
                id="fx-base"
                name="baseCurrency"
                pattern="[A-Z]{3}"
                placeholder="USD"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="fx-quote">Quote currency</label>
              <input id="fx-quote" value="INR" readOnly />
            </div>
            <div className="field">
              <label htmlFor="fx-numerator">Rate numerator</label>
              <input id="fx-numerator" name="rateNumerator" inputMode="numeric" required />
            </div>
            <div className="field">
              <label htmlFor="fx-denominator">Rate denominator</label>
              <input id="fx-denominator" name="rateDenominator" inputMode="numeric" required />
            </div>
            <div className="field">
              <label htmlFor="fx-effective">Effective at</label>
              <input id="fx-effective" name="effectiveAt" type="datetime-local" required />
            </div>
            <div className="field">
              <label htmlFor="fx-provenance">Provenance</label>
              <textarea id="fx-provenance" name="provenance" required />
            </div>
            {drawer.error && (
              <div className="field-error" role="alert">
                {drawer.error}
              </div>
            )}
            <button className="button primary" disabled={drawer.busy}>
              {drawer.busy ? 'Storing…' : 'Store immutable FX version'}
            </button>
          </form>
        </Drawer>
      )}
    </div>
  );
}

function flatRow(
  series: readonly LineSeries[],
  index: number,
): { label: string; point: { x: number; y: number } } | undefined {
  const flat = series.flatMap((s) => s.points.map((point) => ({ label: s.label, point })));
  return flat[index];
}
