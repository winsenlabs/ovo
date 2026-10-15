'use client';
import { Select } from '../../components/ui/inputs';
import type { HoldStep, HoldTimeoutStep } from '../../lib/types/queues';
import { NumberField, optionsFrom, TextField } from './fields';
import { LinesEditor } from './lines-editor';

export interface AudioOption {
  value: string;
  label: string;
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

/** One row of a list the operator can reorder by removing and adding; shared by both lists. */
function Row({
  label,
  kind,
  kinds,
  onKind,
  onRemove,
  children,
}: {
  label: string;
  kind: string;
  kinds: readonly { value: string; label: string }[];
  onKind: (kind: string) => void;
  onRemove: () => void;
  children?: React.ReactNode;
}) {
  return (
    <li className="queue-row">
      <Select aria-label={`${label} type`} value={kind} options={kinds} onChange={onKind} />
      <div className="queue-row-body">{children}</div>
      <button type="button" className="text-button" aria-label={`Remove ${label}`} onClick={onRemove}>
        Remove
      </button>
    </li>
  );
}

export function StepList({
  steps,
  audio,
  onChange,
}: {
  steps: HoldStep[];
  audio: readonly AudioOption[];
  onChange: (steps: HoldStep[]) => void;
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
          >
            {step.kind === 'silence' && (
              <NumberField
                id={`hold-step-${index}-seconds`}
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

export function TimeoutList({
  steps,
  onChange,
}: {
  steps: HoldTimeoutStep[];
  onChange: (steps: HoldTimeoutStep[]) => void;
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
          >
            {step.kind === 'human' && (
              <TextField
                id={`timeout-${index}-queue`}
                label="Queue key"
                value={step.queueId}
                onChange={(queueId) => replace(index, { kind: 'human', queueId })}
              />
            )}
            {step.kind === 'target' && (
              <TextField
                id={`timeout-${index}-target`}
                label="Target key"
                value={step.key}
                onChange={(key) => replace(index, { kind: 'target', key })}
              />
            )}
            {step.kind === 'callback' && (
              <>
                <NumberField
                  id={`timeout-${index}-minutes`}
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
