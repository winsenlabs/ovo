'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError, type SessionIdentity } from '../../lib/api';
import type { ScenarioResult } from '../../lib/operator-api';
import { Field, Notice, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';
import { BudgetPanel } from './budget-panel';
import { FxVersionPanel } from './fx-version-panel';
import { PriceCardPanel } from './price-card-panel';
import { ReconciliationPanel } from './reconciliation-panel';

const categories = ['telephony', 'tax', 'speech-generation', 'carrier-media', 'idle'] as const;
type ComponentDraft = {
  id: string;
  category: (typeof categories)[number];
  amountMinor: string;
  assumption: string;
};
const initialComponents = (): ComponentDraft[] =>
  categories.map((category) => ({ id: category, category, amountMinor: '', assumption: '' }));
const formatInr = (paise: string) => {
  const value = Number(paise);
  return Number.isSafeInteger(value)
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value / 100)
    : `${paise} paise`;
};

export function CostView({ role }: { role: SessionIdentity['role'] }) {
  const [target, setTarget] = useState('');
  const [duration, setDuration] = useState('');
  const [marginScope, setMarginScope] = useState('');
  const [generatedUnits, setGeneratedUnits] = useState('');
  const [hitUnits, setHitUnits] = useState('');
  const [cacheAssumption, setCacheAssumption] = useState('');
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
          targetRevenuePaise: target,
          durationSeconds: duration,
          components: components.map((component) => ({ ...component, currency: 'INR' })),
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
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Financial controls</p>
          <h1>Costs & budgets</h1>
          <p className="muted">
            Exact paise-based scenarios and persisted admission budgets. Missing provider usage is
            never treated as free.
          </p>
        </div>
      </header>
      <Panel labelledBy="scenario-title">
        <PanelHeader
          id="scenario-title"
          title="INR margin scenario"
          badge={<StatusBadge tone="soft">Explicit assumptions</StatusBadge>}
        />
        <form className="panel-body stack" onSubmit={calculate}>
          <div className="form-grid">
            <Field label="Target revenue (paise)" htmlFor="scenario-target">
              <input
                id="scenario-target"
                inputMode="numeric"
                pattern="\d+"
                required
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </Field>
            <Field label="Call duration (seconds)" htmlFor="scenario-duration">
              <input
                id="scenario-duration"
                inputMode="numeric"
                pattern="\d+"
                required
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </Field>
            <Field label="Margin scope" htmlFor="scenario-scope">
              <input
                id="scenario-scope"
                required
                value={marginScope}
                onChange={(event) => setMarginScope(event.target.value)}
                placeholder="Per completed call"
              />
            </Field>
          </div>
          <ResponsiveTable label="Scenario cost assumptions">
            <thead>
              <tr>
                <th>Category</th>
                <th>Cost (paise)</th>
                <th>Assumption and provenance</th>
              </tr>
            </thead>
            <tbody>
              {components.map((component, index) => (
                <tr key={component.category}>
                  <td>{component.category}</td>
                  <td>
                    <input
                      aria-label={`${component.category} cost in paise`}
                      inputMode="numeric"
                      pattern="\d+"
                      required
                      value={component.amountMinor}
                      onChange={(event) =>
                        setComponents((current) =>
                          current.map((item, position) =>
                            position === index
                              ? { ...item, amountMinor: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${component.category} assumption`}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
          <div className="form-grid">
            <Field label="Generated speech units" htmlFor="scenario-generated">
              <input
                id="scenario-generated"
                required
                inputMode="decimal"
                value={generatedUnits}
                onChange={(event) => setGeneratedUnits(event.target.value)}
              />
            </Field>
            <Field label="Cached-hit units" htmlFor="scenario-hits">
              <input
                id="scenario-hits"
                required
                inputMode="decimal"
                value={hitUnits}
                onChange={(event) => setHitUnits(event.target.value)}
              />
            </Field>
            <Field label="Cache billing assumption" htmlFor="scenario-cache">
              <input
                id="scenario-cache"
                required
                value={cacheAssumption}
                onChange={(event) => setCacheAssumption(event.target.value)}
              />
            </Field>
          </div>
          <Notice>
            Speech generation is billed once on a cache miss; carrier media remains billable on
            cache hits. Those invariants are fixed by the server calculator.
          </Notice>
          {error && (
            <Notice tone="danger" live>
              {error}
            </Notice>
          )}
          <button className="button primary align-start" disabled={busy}>
            {busy ? 'Calculating…' : 'Calculate from assumptions'}
          </button>
          {result && (
            <div className="metrics">
              <div>
                <span>Total cost</span>
                <strong>{formatInr(result.totalCostPaise)}</strong>
                <small>{result.durationSeconds} seconds</small>
              </div>
              <div>
                <span>Margin</span>
                <strong>{formatInr(result.marginPaise)}</strong>
                <small>{result.marginScope}</small>
              </div>
              <div>
                <span>Target</span>
                <strong>{result.withinTarget ? 'Within' : 'Exceeded'}</strong>
                <small>{formatInr(result.targetRevenuePaise)}</small>
              </div>
            </div>
          )}
        </form>
      </Panel>
      <PriceCardPanel role={role} />
      <FxVersionPanel role={role} />
      <ReconciliationPanel role={role} />
      <BudgetPanel role={role} />
    </div>
  );
}
