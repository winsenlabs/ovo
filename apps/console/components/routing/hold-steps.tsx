'use client';
import { Select } from '../ui/inputs';
import { moveItem } from '../../lib/derive/list-edit';
import type { HoldStep, HoldTimeoutStep } from '../../lib/types/queues';
import { NumberField, optionsFrom, SelectField, TextField } from './fields';
import { LinesEditor } from './lines-editor';

export interface AudioOption {
  value: string;
  label: string;
}

/** Keys a timeout step can name; when given, the step picks from them instead of typing a key. */
export interface HoldChoices {
  queues?: readonly string[];
  targets?: readonly string[];
}

const STEP_KINDS = optionsFrom({
  silence: 'Silence',
  line: 'Spoken line',
  clip: 'Music or recording',
});
const TIMEOUT_KINDS = optionsFrom({
  return: 'Return to the AI agent',
  default: 'Release the default agent',
  human: 'Try another queue',
  target: 'Transfer to a target',
  callback: 'Offer a callback',
  end: 'End the call politely',
});

export function blankStep(kind: string): HoldStep {
  if (kind === 'clip') return { kind, assetId: '' };
  if (kind === 'line') return { kind, line: { en: 'Thank you for holding.' } };
  return { kind: 'silence', seconds: 3 };
}

export function blankTimeout(kind: string): HoldTimeoutStep {
  if (kind === 'human') return { kind, queueId: '' };
  if (kind === 'target') return { kind, key: '' };
  if (kind === 'callback') return { kind, inMinutes: 120, line: { en: 'We will call you back.' } };
  if (kind === 'end') return { kind, line: { en: 'Goodbye.' } };
  return { kind: kind === 'default' ? 'default' : 'return' };
}

/** One row of a reorderable list; shared by both lists. Reordering is by buttons, never drag. */
function Row({
  label,
  kind,
  kinds,
  onKind,
  onRemove,
  onMove,
  first,
  last,
  children,
}: {
  label: string;
  kind: string;
  kinds: readonly { value: string; label: string }[];
  onKind: (kind: string) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  first: boolean;
  last: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className="queue-row">
      <Select aria-label={`${label} type`} value={kind} options={kinds} onChange={onKind} />
      <div className="queue-row-body">{children}</div>
      <span className="rt-row-actions">
        <button
          type="button"
          className="text-button"
          aria-label={`Move ${label} up`}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          Up
        </button>
        <button
          type="button"
          className="text-button"
          aria-label={`Move ${label} down`}
          disabled={last}
          onClick={() => onMove(1)}
        >
          Down
        </button>
        <button
          type="button"
          className="text-button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </span>
    </li>
  );
}

export function StepList({
  steps,
  audio,
  onChange,
  idPrefix = 'hold',
}: {
  steps: HoldStep[];
  audio: readonly AudioOption[];
  onChange: (steps: HoldStep[]) => void;
  idPrefix?: string;
}) {
  const replace = (index: number, step: HoldStep) =>
    onChange(steps.map((existing, i) => (i === index ? step : existing)));
  return (
    <>
      <ol className="queue-rows" aria-label="Hold sequence">
        {steps.map((step, index) => (
          <Row
            key={index}
            label={`Hold step ${index + 1}`}
            kind={step.kind}
            kinds={STEP_KINDS}
            onKind={(kind) => replace(index, blankStep(kind))}
            onRemove={() => onChange(steps.filter((_, i) => i !== index))}
            onMove={(delta) => onChange(moveItem(steps, index, delta))}
            first={index === 0}
            last={index === steps.length - 1}
          >
            {step.kind === 'silence' && (
              <NumberField
                id={`${idPrefix}-step-${index}-seconds`}
                label="Seconds"
                value={step.seconds}
                min={1}
                max={60}
                onChange={(seconds) => replace(index, { kind: 'silence', seconds })}
              />
            )}
            {step.kind === 'line' && (
              <LinesEditor
                label={`Hold step ${index + 1} line`}
                required
                value={step.line}
                onChange={(line) => line && replace(index, { kind: 'line', line })}
              />
            )}
            {step.kind === 'clip' && (
              <label>
                Clip
                <Select
                  value={step.assetId}
                  placeholder={audio.length ? 'Choose a clip…' : 'No clips uploaded'}
                  options={audio}
                  onChange={(assetId) => replace(index, { ...step, assetId })}
                />
              </label>
            )}
          </Row>
        ))}
      </ol>
      <button
        type="button"
        className="button"
        disabled={steps.length >= 12}
        onClick={() => onChange([...steps, blankStep('silence')])}
      >
        Add hold step
      </button>
    </>
  );
}

function KeyField({
  id,
  label,
  value,
  choices,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  choices?: readonly string[];
  onChange: (value: string) => void;
}) {
  return choices ? (
    <SelectField
      id={id}
      label={label}
      value={value}
      placeholder="Choose…"
      options={choices.map((c) => ({ value: c, label: c }))}
      onChange={onChange}
    />
  ) : (
    <TextField id={id} label={label} value={value} onChange={onChange} />
  );
}

export function TimeoutList({
  steps,
  onChange,
  idPrefix = 'timeout',
  choices,
}: {
  steps: HoldTimeoutStep[];
  onChange: (steps: HoldTimeoutStep[]) => void;
  idPrefix?: string;
  choices?: HoldChoices;
}) {
  const replace = (index: number, step: HoldTimeoutStep) =>
    onChange(steps.map((existing, i) => (i === index ? step : existing)));
  return (
    <>
      <ol className="queue-rows" aria-label="If the wait runs out">
        {steps.map((step, index) => (
          <Row
            key={index}
            label={`Timeout step ${index + 1}`}
            kind={step.kind}
            kinds={TIMEOUT_KINDS}
            onKind={(kind) => replace(index, blankTimeout(kind))}
            onRemove={() => onChange(steps.filter((_, i) => i !== index))}
            onMove={(delta) => onChange(moveItem(steps, index, delta))}
            first={index === 0}
            last={index === steps.length - 1}
          >
            {step.kind === 'human' && (
              <KeyField
                id={`${idPrefix}-${index}-queue`}
                label="Queue key"
                value={step.queueId}
                choices={choices?.queues}
                onChange={(queueId) => replace(index, { kind: 'human', queueId })}
              />
            )}
            {step.kind === 'target' && (
              <KeyField
                id={`${idPrefix}-${index}-target`}
                label="Target key"
                value={step.key}
                choices={choices?.targets}
                onChange={(key) => replace(index, { kind: 'target', key })}
              />
            )}
            {step.kind === 'callback' && (
              <>
                <NumberField
                  id={`${idPrefix}-${index}-minutes`}
                  label="Call back in"
                  unit="minutes"
                  min={5}
                  max={10080}
                  value={step.inMinutes}
                  onChange={(inMinutes) => replace(index, { ...step, inMinutes })}
                />
                <LinesEditor
                  label={`Timeout step ${index + 1} line`}
                  required
                  value={step.line}
                  onChange={(line) => line && replace(index, { ...step, line })}
                />
              </>
            )}
            {step.kind === 'end' && (
              <LinesEditor
                label={`Timeout step ${index + 1} line`}
                required
                value={step.line}
                onChange={(line) => line && replace(index, { ...step, line })}
              />
            )}
          </Row>
        ))}
      </ol>
      <button
        type="button"
        className="button"
        disabled={steps.length >= 5}
        onClick={() => onChange([...steps, blankTimeout('end')])}
      >
        Add timeout step
      </button>
    </>
  );
}
