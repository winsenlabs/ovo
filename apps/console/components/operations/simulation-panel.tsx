'use client';
import type { FormEvent } from 'react';
import type { Release } from '../../lib/api';
import { Field, Panel, PanelHeader, StatusBadge } from '../primitives';
import { JsonEditor } from '../forms/json-editor';
import type { SimulationMode } from './simulation-request';
export function SimulationPanel({ releases, simulationMode, setSimulationMode, simulationBindings, setSimulationBindings, simulate }: {
  releases: Release[]; simulationMode: SimulationMode;
  setSimulationMode: (mode: SimulationMode) => void;
  simulationBindings: Record<string, unknown>;
  setSimulationBindings: (bindings: Record<string, unknown>) => void;
  simulate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
        <Panel labelledBy="simulation-title">
          <PanelHeader
            id="simulation-title"
            title="Run a simulation"
            badge={
              <StatusBadge tone={simulationMode === 'fixture' ? 'soft' : 'warning'}>
                {simulationMode === 'fixture' ? 'Fixture isolation' : 'Provider-backed'}
              </StatusBadge>
            }
          />
          <form className="panel-body stack" onSubmit={simulate}>
            <Field label="Immutable release" htmlFor="simulation-release">
              <select id="simulation-release" name="releaseId" required>
                <option value="">Select release</option>
                {releases.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.config.name} · {release.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Caller input" htmlFor="simulation-input">
              <textarea id="simulation-input" name="input" required />
            </Field>
            <Field
              label="Follow-up caller inputs"
              htmlFor="simulation-follow-ups"
              help="Optional: one non-empty turn per line, maximum 19. The same immutable composition and simulated playback receipts are used until the script reaches a terminal node."
            >
              <textarea id="simulation-follow-ups" name="followUpInputs" />
            </Field>
            <Field
              label="Execution mode"
              htmlFor="simulation-mode"
              help="Fixture isolation is the safe default and makes no provider or tool requests."
            >
              <select
                id="simulation-mode"
                value={simulationMode}
                onChange={(event) => setSimulationMode(event.target.value as SimulationMode)}
              >
                <option value="fixture">Fixture isolation — no provider or tool requests</option>
                <option value="provider">Provider-backed — may incur cost</option>
              </select>
            </Field>
            {simulationMode === 'fixture' ? (
              <Field
                label="Fixture bindings JSON"
                htmlFor="simulation-bindings"
                help='Optional modelReplies entries are {"kind":"text","text":"…"} or {"kind":"tool","toolId":"…","input":{}}. toolResults maps each tool ID to its fixture result. An empty object stays isolated and uses uncertainty/errors for missing fixtures.'
              >
                <JsonEditor
                  id="simulation-bindings"
                  value={simulationBindings}
                  onValid={value => setSimulationBindings(value as Record<string, unknown>)}
                />
              </Field>
            ) : (
              <div className="muted">
                Provider-backed simulation may call configured models and approved read tools and
                can incur cost. Allowed write tools without fixture bindings are rejected as unsafe.
              </div>
            )}
            <button className="button primary align-start" disabled={!releases.length}>
              {simulationMode === 'fixture'
                ? 'Run isolated fixture simulation'
                : 'Run provider-backed simulation'}
            </button>
            {!releases.length && <small>Publish an API-validated release first.</small>}
          </form>
        </Panel>

  );
}
