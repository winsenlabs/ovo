'use client';
import type { ReactNode } from 'react';
import { SelectField, TextField } from '../../../components/routing/fields';
import { ErrorState } from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import type { SimForm } from '../../../lib/derive/routing-simulate';
import { SIMULATION_LIMITS } from '../../../lib/types/routing-simulate';

export const DRAFT = '__draft__';
const localNow = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** What to run, the caller and the clock: the first three sections of the tester's form. */
export function SimTargetSections({
  form,
  pointId,
  targetOptions,
  releaseId,
  loadError,
  zone,
  onChange: set,
}: {
  form: SimForm;
  pointId: string;
  targetOptions: { value: string; label: string }[];
  releaseId: string | undefined;
  loadError: string | undefined;
  zone: string;
  onChange: (patch: Partial<SimForm>) => void;
}): ReactNode {
  return (
    <>
          <SectionCard title="What to run">
            <SelectField
              id="sim-target"
              label="Run"
              value={releaseId ?? DRAFT}
              options={targetOptions}
              help={
                releaseId
                  ? undefined
                  : 'The draft is checked like a publish; a draft with blockers cannot be run.'
              }
              onChange={(value) =>
                set({
                  target:
                    value === DRAFT
                      ? { kind: 'draft', pointId }
                      : { kind: 'release', routingReleaseId: value },
                  answers: [],
                })
              }
            />
            {loadError && <ErrorState message={loadError} />}
          </SectionCard>
          <SectionCard title="The caller">
            <div className="rt-grid">
              <TextField
                id="sim-from"
                label="Calling from"
                mono
                placeholder="+918040000001"
                value={form.from}
                onChange={(from) => set({ from })}
              />
              <TextField
                id="sim-to"
                label="Dialled number"
                mono
                placeholder="+918069450000"
                value={form.to}
                onChange={(to) => set({ to })}
              />
            </div>
            <fieldset className="queue-section">
              <legend>Call variables</legend>
              {form.variables.map((v, i) => (
                <div key={i} className="rt-grid">
                  <TextField
                    id={`sim-var-${i}-name`}
                    label="Name"
                    value={v.name}
                    onChange={(name) =>
                      set({
                        variables: form.variables.map((x, n) => (n === i ? { ...x, name } : x)),
                      })
                    }
                  />
                  <TextField
                    id={`sim-var-${i}-value`}
                    label="Value"
                    value={v.value}
                    onChange={(value) =>
                      set({
                        variables: form.variables.map((x, n) => (n === i ? { ...x, value } : x)),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => set({ variables: form.variables.filter((_, n) => n !== i) })}
                  >
                    Remove variable {i + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                disabled={form.variables.length >= SIMULATION_LIMITS.variables}
                onClick={() => set({ variables: [...form.variables, { name: '', value: '' }] })}
              >
                Add a variable
              </button>
            </fieldset>
          </SectionCard>
          <SectionCard
            title="The time"
            description={`Time rules and member hours read this clock. Read in ${zone}.`}
          >
            <div className="button-row">
              <label className="field">
                <span>Call time</span>
                <input
                  type="datetime-local"
                  aria-label="Call time"
                  value={form.at}
                  onChange={(e) => set({ at: e.target.value })}
                />
              </label>
              <button type="button" className="button" onClick={() => set({ at: localNow() })}>
                Use this moment
              </button>
              <button
                type="button"
                className="button"
                disabled={!form.at}
                onClick={() => set({ at: '' })}
              >
                Use the server clock
              </button>
            </div>
          </SectionCard>
    </>
  );
}
