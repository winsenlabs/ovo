'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { ScenarioResult } from '../../lib/operator-api';
import { formatMoney } from '../../lib/format';
import { scenarioBreakdownBars, scenarioMeter } from '../../lib/derive/costs';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { ChartFrame } from '../charts/chart-frame';
import { BarChart } from '../charts/bar-chart';
import { ProgressMeter } from '../charts/meter';
import { InlineAlert } from '../ui/feedback-v2';
import grid from './insights-grid.module.css';

const CATEGORIES = ['telephony', 'tax', 'speech-generation', 'carrier-media', 'idle'] as const;
type ComponentDraft = { category: (typeof CATEGORIES)[number]; rupees: string; assumption: string };
const initialComponents = (): ComponentDraft[] =>
  CATEGORIES.map((category) => ({ category, rupees: '', assumption: '' }));

/** Rupees -> integer paise, half-up, for the exact-paise request the server expects. */
function toPaise(rupees: string): string {
  const value = Number(rupees);
  return Number.isFinite(value) ? String(Math.round(value * 100)) : '0';
}

/**
 * The INR margin scenario calculator. Inputs are now in ₹ (with the paise equivalent shown as a
 * hint) instead of raw paise, and the result is a cost-breakdown bar plus a spent-vs-target meter
 * instead of three bare numbers — the brief's "waterfall or stacked bar… vs targetRevenuePaise".
 */
export function ScenarioPanel() {
  const [targetRupees, setTargetRupees] = useState('');
  const [duration, setDuration] = useState('');
  const [marginScope, setMarginScope] = useState('Per completed call');
  const [generatedUnits, setGeneratedUnits] = useState('');
  const [hitUnits, setHitUnits] = useState('');
  const [cacheAssumption, setCacheAssumption] = useState(
    'Speech generation billed once per cache miss',
  );
  const [components, setComponents] = useState(initialComponents);
  const [result, setResult] = useState<ScenarioResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function calculate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const { data } = await apiRequest<ScenarioResult>('/cost/scenario', {
        method: 'POST',
        body: JSON.stringify({
          targetRevenuePaise: toPaise(targetRupees),
          durationSeconds: duration,
          components: components.map((component) => ({
            id: component.category,
            category: component.category,
            amountMinor: toPaise(component.rupees),
            assumption: component.assumption,
            currency: 'INR',
          })),
          cache: {
            generatedUnits,
            hitUnits,
            generationBilledOnce: true,
            carrierMediaStillBilled: true,
            assumption: cacheAssumption,
          },
          marginScope,
        }),
      });
      setResult(data);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'The cost ledger is not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Scenario calculation failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  const bars = useMemo(() => (result ? scenarioBreakdownBars(result) : []), [result]);
  const meter = useMemo(() => (result ? scenarioMeter(result) : null), [result]);

  return (
    <div className={grid.twoColumn}>
      <SectionCard
        title="INR margin scenario"
        description="Exact paise-based assumptions. Missing provider usage is never treated as free."
        padding="prose"
      >
        <form className="stack" onSubmit={calculate}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="scenario-target">Target revenue</label>
              <input
                id="scenario-target"
                inputMode="decimal"
                required
                value={targetRupees}
                onChange={(event) => setTargetRupees(event.target.value)}
              />
              <small>
                ₹{targetRupees || '0'} = {toPaise(targetRupees || '0')} paise
              </small>
            </div>
            <div className="field">
              <label htmlFor="scenario-duration">Call duration (seconds)</label>
              <input
                id="scenario-duration"
                inputMode="numeric"
                pattern="\d+"
                required
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="scenario-scope">Margin scope</label>
              <input
                id="scenario-scope"
                required
                value={marginScope}
                onChange={(event) => setMarginScope(event.target.value)}
              />
            </div>
          </div>
          <fieldset className="stack">
            <legend>Cost assumptions, in ₹ per call</legend>
            {components.map((component, index) => (
              <div className="form-grid" key={component.category}>
                <div className="field">
                  <label htmlFor={`scenario-amount-${component.category}`}>
                    {component.category}
                  </label>
                  <input
                    id={`scenario-amount-${component.category}`}
                    inputMode="decimal"
                    required
                    value={component.rupees}
                    onChange={(event) =>
                      setComponents((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, rupees: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`scenario-assumption-${component.category}`}>
                    Assumption / provenance
                  </label>
                  <input
                    id={`scenario-assumption-${component.category}`}
                    required
                    value={component.assumption}
                    onChange={(event) =>
                      setComponents((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, assumption: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </div>
              </div>
            ))}
          </fieldset>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="scenario-generated">Generated speech units</label>
              <input
                id="scenario-generated"
                required
                inputMode="decimal"
                value={generatedUnits}
                onChange={(event) => setGeneratedUnits(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="scenario-hits">Cached-hit units</label>
              <input
                id="scenario-hits"
                required
                inputMode="decimal"
                value={hitUnits}
                onChange={(event) => setHitUnits(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="scenario-cache">Cache billing assumption</label>
              <input
                id="scenario-cache"
                required
                value={cacheAssumption}
                onChange={(event) => setCacheAssumption(event.target.value)}
              />
            </div>
          </div>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary align-start" disabled={busy}>
            {busy ? 'Calculating…' : 'Calculate from assumptions'}
          </button>
        </form>
      </SectionCard>
      <SectionCard title="Result" description="Cost breakdown against the target revenue.">
        {!result ? (
          <InlineAlert tone="info">Run the scenario to see the cost breakdown.</InlineAlert>
        ) : (
          <div className="ds-stack">
            <KpiStrip>
              <KpiCard label="Total cost" value={formatMoney(result.totalCostPaise)} />
              <KpiCard
                label="Margin"
                value={formatMoney(result.marginPaise)}
                footnote={result.marginScope}
              />
              <KpiCard
                label="Target"
                value={
                  <StatusBadgeV2
                    tone={result.withinTarget ? 'ok' : 'danger'}
                    label={result.withinTarget ? 'Within' : 'Exceeded'}
                  />
                }
                footnote={formatMoney(result.targetRevenuePaise)}
              />
            </KpiStrip>
            {meter && (
              <ProgressMeter
                label="Cost vs target revenue"
                segments={meter.segments}
                max={meter.max}
                valueLabel={`${formatMoney(result.totalCostPaise)} of ${formatMoney(result.targetRevenuePaise)}`}
              />
            )}
            <ChartFrame
              ariaLabel="Cost breakdown by category"
              height={180}
              tableRows={bars.length}
              tableColumns={[
                { header: 'Category', cell: (i) => bars[i]?.category },
                { header: 'Amount', cell: (i) => formatMoney((bars[i]?.values.amount ?? 0) * 100) },
              ]}
              renderChart={(width) => (
                <BarChart
                  data={bars}
                  seriesKeys={['amount']}
                  width={width}
                  orientation="horizontal"
                  valueFormat={(value) => formatMoney(value * 100)}
                />
              )}
            />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
