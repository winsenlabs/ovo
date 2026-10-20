'use client';
import { DecimalField, SelectField } from '../../../components/routing/fields';
import { Switch } from '../../../components/ui/display';
import { answerOf, setAnswer, type EngineSlot, type SimForm } from '../../../lib/derive/routing-simulate';
import { ENGINE_LABEL } from '../../../lib/derive/routing-labels';
import type { RoutingStatus } from '../../../lib/types/routing';
import type { SimulatedAnswer, SimulatedEngine, SimulatedOutcome } from '../../../lib/types/routing-simulate';

const OUTCOMES: { value: SimulatedOutcome | ''; label: string }[] = [
  { value: '', label: 'Matched, or low confidence if under the threshold' },
  { value: 'no_match', label: 'Found no match' },
  { value: 'timeout', label: 'Timed out' },
  { value: 'error', label: 'Failed' },
  { value: 'disabled', label: 'Not available' },
];

/** Why a real (live) engine cannot be used, or nothing when it can. */
export function liveReason(engine: SimulatedEngine, status: RoutingStatus, isAdmin: boolean): string | undefined {
  if (!isAdmin) return 'Only admins can run real engines.';
  const sim = status.simulate;
  if (!sim?.enabled) return 'Real engines are not enabled on this installation.';
  if (engine === 'external') return sim.liveExternal ? undefined : 'Real external calls are switched off here.';
  return sim.liveLlm ? undefined : 'Real model calls are switched off here.';
}

function Row({ slot, form, onChange, languages }: { slot: EngineSlot; form: SimForm; onChange: (form: SimForm) => void; languages: readonly string[] }) {
  const answer = answerOf(form.answers, slot);
  const set = (next: SimulatedAnswer | undefined) => onChange({ ...form, answers: setAnswer(form.answers, slot, next) });
  const base: SimulatedAnswer = answer ?? { node: slot.node, engine: slot.engine, branch: slot.branches[0], confidence: 0.9, repeat: false };
  return (
    <fieldset className="rt-card rt-answer" disabled={form.modes[slot.engine] === 'live'}>
      <legend>
        {slot.node}: {ENGINE_LABEL[slot.engine]}
      </legend>
      <div className="rt-grid">
        <SelectField
          id={`ans-${slot.key}-branch`}
          label="Answers with branch"
          value={answer?.branch ?? ''}
          placeholder="No scripted answer"
          options={slot.branches.map((b) => ({ value: b, label: b }))}
          onChange={(branch) => set(branch ? { ...base, branch } : undefined)}
        />
        {answer && (
          <>
            <DecimalField id={`ans-${slot.key}-confidence`} label="Confidence" value={answer.confidence ?? 0.9} onChange={(confidence) => set({ ...answer, confidence })} help={`Threshold ${slot.threshold}`} />
            <SelectField id={`ans-${slot.key}-outcome`} label="Result" value={answer.outcome ?? ''} options={OUTCOMES} onChange={(outcome) => set({ ...answer, outcome: (outcome || undefined) as SimulatedOutcome | undefined })} />
            {slot.detectLanguage && (
              <SelectField id={`ans-${slot.key}-language`} label="Language it detects" value={answer.language ?? ''} placeholder="None" options={languages.map((l) => ({ value: l, label: l }))} onChange={(language) => set({ ...answer, language: language || undefined })} />
            )}
          </>
        )}
      </div>
    </fieldset>
  );
}

/** Per-engine answers (scripted), and the switch to run each engine for real instead. */
export function AnswersEditor({
  slots,
  form,
  onChange,
  status,
  isAdmin,
  languages,
}: {
  slots: EngineSlot[];
  form: SimForm;
  onChange: (form: SimForm) => void;
  status: RoutingStatus;
  isAdmin: boolean;
  languages: readonly string[];
}) {
  const engines = [...new Set(slots.map((s) => s.engine))];
  if (!slots.length) return <p className="muted">This tree uses only rules, which always run for real. Nothing to script.</p>;
  return (
    <div className="rt-stack">
      <p className="muted">
        Model, decision and external engines are scripted by default, so a run tests the tree and
        the rules, not a model. Rules always run for real.
      </p>
      <div className="rt-stack">
        {engines.map((engine) => {
          const reason = liveReason(engine, status, isAdmin);
          return (
            <div key={engine}>
              <Switch
                label={`Use the real ${ENGINE_LABEL[engine].toLowerCase()} (costs money and takes longer)`}
                checked={form.modes[engine] === 'live'}
                disabled={reason !== undefined}
                onChange={(on) => onChange({ ...form, modes: { ...form.modes, [engine]: on ? 'live' : 'mock' } })}
              />
              {reason && <small className="muted"> {reason}</small>}
            </div>
          );
        })}
      </div>
      {slots.map((slot) => (
        <Row key={slot.key} slot={slot} form={form} onChange={onChange} languages={languages} />
      ))}
    </div>
  );
}
