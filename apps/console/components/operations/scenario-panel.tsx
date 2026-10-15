'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import type { ScenarioResult } from '../../lib/operator-api';
import { humaniseEnum } from '../../lib/status';
import { SectionCard } from '../ui/section-card';
import { ScenarioResultPanel } from './scenario-result-panel';
import grid from './insights-grid.module.css';

const CATEGORIES = ['telephony', 'tax', 'speech-generation', 'carrier-media', 'idle'] as const;
type ComponentDraft = { category: (typeof CATEGORIES)[number]; rupees: string; assumption: string };
const initialComponents = (): ComponentDraft[] =>
  CATEGORIES.map((category) => ({ category, rupees: '', assumption: '' }));

/** Rupees -> exact integer paise with no floating-point math, or `null` for anything that is not
 * a plain (optionally grouped, optionally ≤2-decimal) non-negative amount. `Number("1,000")` is
 * `NaN`, but `Number.isFinite` was never checked against the *parsed* string — `toPaise` silently
 * turned "1,000" (and any other non-numeric text) into `0` paise instead of rejecting it
 * (verifier medium #9). */
function parseRupeesToPaise(rupees: string): bigint | null {
  const cleaned = rupees.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const paiseFraction = fraction.padEnd(2, '0').slice(0, 2);
  return BigInt(whole) * 100n + BigInt(paiseFraction);
}

/** Display-only: the paise hint for a ₹ field, or an em dash while the typed text doesn't parse
 * (never a misleading "= 0 paise"). */
function paiseHint(rupees: string): string {
  const paise = parseRupeesToPaise(rupees || '0');
  return paise == null ? '—' : paise.toString();
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
    setError(undefined);
    const targetPaise = parseRupeesToPaise(targetRupees);
    if (targetPaise == null) {
      setError('Target revenue must be a plain ₹ amount, such as 1000 or 1000.50.');
      return;
    }
    const componentPaise = components.map((component) => ({
      ...component,
      paise: parseRupeesToPaise(component.rupees),
    }));
    const invalidComponent = componentPaise.find((component) => component.paise == null);
    if (invalidComponent) {
      setError(
        `"${humaniseEnum(invalidComponent.category)}" cost must be a plain ₹ amount, such as 1000 or 1000.50.`,
      );
      return;
    }
    setBusy(true);
    setResult(undefined);
    try {
      const { data } = await apiRequest<ScenarioResult>('/cost/scenario', {
        method: 'POST',
        body: JSON.stringify({
          targetRevenuePaise: targetPaise.toString(),
          durationSeconds: duration,
          components: componentPaise.map((component) => ({
            id: component.category,
            category: component.category,
            amountMinor: component.paise!.toString(),
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
                ₹{targetRupees || '0'} = {paiseHint(targetRupees)} paise
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
          <fieldset className="nested-card">
            <legend>Cost assumptions, in ₹ per call</legend>
            {components.map((component, index) => (
              <div className="form-grid" key={component.category}>
                <div className="field">
                  <label htmlFor={`scenario-amount-${component.category}`}>
                    {humaniseEnum(component.category)}
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
            {/* Full width (not the form-grid's equal third column): the default assumption text
                is long enough that a shared column truncated it to a few visible characters
                (verifier minor #15). */}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
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
      <ScenarioResultPanel result={result} />
    </div>
  );
}
