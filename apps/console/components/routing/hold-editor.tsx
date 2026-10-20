'use client';
import { DEFAULT_HOLD } from '../../lib/derive/queues';
import type { HoldPolicy } from '../../lib/types/queues';
import { NumberField, SwitchField } from './fields';
import { StepList, TimeoutList, type AudioOption, type HoldChoices } from './hold-steps';

/** The wait: what the caller hears, for how long, and what happens when it runs out. */
export function HoldEditor({
  value,
  audio,
  onChange,
  idPrefix = 'queue-hold',
  offHelp = "Off: the routing point's hold applies, else three minutes of silence, then back to the agent.",
  choices,
  waitForCapacity = false,
}: {
  value: HoldPolicy | undefined;
  audio: readonly AudioOption[];
  onChange: (value: HoldPolicy | undefined) => void;
  /** Distinguishes the controls of two hold editors on one page. */
  idPrefix?: string;
  offHelp?: string;
  choices?: HoldChoices;
  /** Routing holds can wait for a pool member with room; a queue hold cannot. */
  waitForCapacity?: boolean;
}) {
  if (!value)
    return (
      <SwitchField
        label="Custom hold experience"
        checked={false}
        help={offHelp}
        onChange={() => onChange(structuredClone(DEFAULT_HOLD))}
      />
    );
  return (
    <div className="queue-hold">
      <SwitchField label="Custom hold experience" checked onChange={() => onChange(undefined)} />
      <NumberField
        id={`${idPrefix}-max`}
        label="Longest wait"
        unit="seconds"
        min={5}
        max={900}
        help="The whole wait, from the end of the announcement."
        value={value.maxSeconds}
        onChange={(maxSeconds) => onChange({ ...value, maxSeconds })}
      />
      {waitForCapacity && (
        <SwitchField
          label="Wait when every agent is busy"
          checked={value.waitForCapacity}
          help="On: hold and retry a full pool instead of refusing straight away."
          onChange={(next) => onChange({ ...value, waitForCapacity: next })}
        />
      )}
      <h4>While the caller waits</h4>
      <StepList
        steps={value.steps}
        audio={audio}
        idPrefix={idPrefix}
        onChange={(steps) => onChange({ ...value, steps })}
      />
      <NumberField
        id={`${idPrefix}-loop`}
        label="Repeat from step"
        min={0}
        max={11}
        help="Step number (from 0) the sequence returns to when it reaches the end."
        value={value.loopFrom}
        onChange={(loopFrom) => onChange({ ...value, loopFrom })}
      />
      <h4>If the wait runs out</h4>
      <p className="muted">
        Tried in order. The last step must release the default agent, offer a callback or end the
        call.
      </p>
      <TimeoutList
        steps={value.onTimeout}
        idPrefix={`${idPrefix}-timeout`}
        choices={choices}
        onChange={(onTimeout) => onChange({ ...value, onTimeout })}
      />
    </div>
  );
}
