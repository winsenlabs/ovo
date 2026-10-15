'use client';
import type { FormEvent } from 'react';
import type { Release } from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { JsonEditor } from '../forms/json-editor';
import type { SimulationMode } from './simulation-request';

/** The "Run a simulation" card, shared with the agent test/evaluation screen (not owned by this
 * area) via the same props — only the markup underneath is W14. */
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
      padding="prose"
      actions={
        <StatusBadgeV2
          tone={simulationMode === 'fixture' ? 'neutral' : 'warn'}
          label={simulationMode === 'fixture' ? 'Fixture isolation' : 'Provider-backed'}
        />
      }
    >
      <form className="ds-stack" onSubmit={simulate}>
        <FormField id="simulation-release" label="Immutable release" required>
          {({ id }) => (
            <select id={id} name="releaseId" required defaultValue="">
              <option value="">Select release</option>
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.config.name} · {release.id}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField id="simulation-input" label="Caller input" required>
          {(control) => <textarea {...control} name="input" />}
        </FormField>
        <FormField
          id="simulation-follow-ups"
          label="Follow-up caller inputs"
          help="Optional: one non-empty turn per line, maximum 19. The same immutable composition and simulated playback receipts are used until the script reaches a terminal node."
        >
          {(control) => <textarea {...control} name="followUpInputs" />}
        </FormField>
        <FormField
          id="simulation-mode"
          label="Execution mode"
          help="Fixture isolation is the safe default and makes no provider or tool requests."
        >
          {({ id }) => (
            <Select
              id={id}
              value={simulationMode}
              onChange={(value) => setSimulationMode(value as SimulationMode)}
              options={[
                { value: 'fixture', label: 'Fixture isolation — no provider or tool requests' },
                { value: 'provider', label: 'Provider-backed — may incur cost' },
              ]}
            />
          )}
        </FormField>
        {simulationMode === 'fixture' ? (
          <FormField
            id="simulation-bindings"
            label="Fixture bindings JSON"
            help='Optional modelReplies entries are {"kind":"text","text":"…"} or {"kind":"tool","toolId":"…","input":{}}. toolResults maps each tool ID to its fixture result. An empty object stays isolated and uses uncertainty/errors for missing fixtures.'
          >
            {({ id }) => (
              <JsonEditor
                id={id}
                value={simulationBindings}
                onValid={(value) => setSimulationBindings(value as Record<string, unknown>)}
              />
            )}
          </FormField>
        ) : (
          <p className="muted">
            Provider-backed simulation may call configured models and approved read tools and can
            incur cost. Allowed write tools without fixture bindings are rejected as unsafe.
          </p>
        )}
        <button type="submit" className="button primary" disabled={!releases.length}>
          {simulationMode === 'fixture'
            ? 'Run isolated fixture simulation'
            : 'Run provider-backed simulation'}
        </button>
        {!releases.length && (
          <small className="muted">Publish an API-validated release first.</small>
        )}
      </form>
    </SectionCard>
  );
}
