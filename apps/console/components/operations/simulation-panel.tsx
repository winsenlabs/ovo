'use client';
import type { FormEvent } from 'react';
import type { Release } from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { JsonEditor } from '../forms/json-editor';
import type { SimulationMode } from './simulation-request';

/**
 * Run a simulation. Relogic (verifier medium #12): the old `Panel`/`PanelHeader`/`Field`
 * primitives are gone in favour of the shared `SectionCard`/`StatusBadgeV2`/`.field` design, and
 * the fixture-bindings JSON editor — the one input that only applies to fixture mode and that
 * most calls never need to touch — moves out from being the form's dominant visual element into
 * an "Advanced" disclosure.
 */
export function SimulationPanel({
  releases,
  simulationMode,
  setSimulationMode,
  simulationBindings,
  setSimulationBindings,
  simulate,
}: {
  releases: Release[];
  simulationMode: SimulationMode;
  setSimulationMode: (mode: SimulationMode) => void;
  simulationBindings: Record<string, unknown>;
  setSimulationBindings: (bindings: Record<string, unknown>) => void;
  simulate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <SectionCard
      title="Run a simulation"
      description="Immutable release, caller script and execution mode. Fixture isolation is the safe default and makes no provider or tool requests."
      padding="prose"
      actions={
        <StatusBadgeV2
          tone={simulationMode === 'fixture' ? 'neutral' : 'warn'}
          label={simulationMode === 'fixture' ? 'Fixture isolation' : 'Provider-backed'}
        />
      }
    >
      <form className="stack" onSubmit={simulate}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="simulation-release">Immutable release</label>
            <select id="simulation-release" name="releaseId" required>
              <option value="">Select release</option>
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.config.name} · {release.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="simulation-mode">Execution mode</label>
            <select
              id="simulation-mode"
              value={simulationMode}
              onChange={(event) => setSimulationMode(event.target.value as SimulationMode)}
            >
              <option value="fixture">Fixture isolation — no provider or tool requests</option>
              <option value="provider">Provider-backed — may incur cost</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="simulation-input">Caller input</label>
          <textarea id="simulation-input" name="input" required />
        </div>
        <div className="field">
          <label htmlFor="simulation-follow-ups">Follow-up caller inputs</label>
          <textarea id="simulation-follow-ups" name="followUpInputs" />
          <small>
            Optional: one non-empty turn per line, maximum 19. The same immutable composition and
            simulated playback receipts are used until the script reaches a terminal node.
          </small>
        </div>
        {simulationMode === 'provider' && (
          <div className="muted">
            Provider-backed simulation may call configured models and approved read tools and can
            incur cost. Allowed write tools without fixture bindings are rejected as unsafe.
          </div>
        )}
        {simulationMode === 'fixture' && (
          <details className="ds-filter-bar">
            <summary className="button">Advanced: fixture bindings</summary>
            <div className="field" style={{ marginTop: 'var(--space-2)' }}>
              <label htmlFor="simulation-bindings">Fixture bindings JSON</label>
              <JsonEditor
                id="simulation-bindings"
                value={simulationBindings}
                onValid={(value) => setSimulationBindings(value as Record<string, unknown>)}
              />
              <small>
                Optional <code>modelReplies</code> entries are{' '}
                <code>{'{"kind":"text","text":"…"}'}</code> or{' '}
                <code>{'{"kind":"tool","toolId":"…","input":{}}'}</code>. <code>toolResults</code>{' '}
                maps each tool ID to its fixture result. An empty object stays isolated and uses
                uncertainty/errors for missing fixtures.
              </small>
            </div>
          </details>
        )}
        <button className="button primary align-start" disabled={!releases.length}>
          {simulationMode === 'fixture'
            ? 'Run isolated fixture simulation'
            : 'Run provider-backed simulation'}
        </button>
        {!releases.length && <small>Publish an API-validated release first.</small>}
      </form>
    </SectionCard>
  );
}
