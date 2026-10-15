'use client';
import type { ExternalQueueDefinition, WebhookSpec } from '../../lib/types/queues';
import { FormSection, NumberField, SwitchField } from './fields';

/** Delivery behaviour: per-attempt timeout, retries with backoff, cancel notice, callback window. */
export function RetryFields({
  spec,
  callbackWindowHours,
  errors,
  onChange,
  onWindow,
}: {
  spec: WebhookSpec;
  callbackWindowHours: ExternalQueueDefinition['callbackWindowHours'];
  errors: Record<string, string | undefined>;
  onChange: (spec: WebhookSpec) => void;
  onWindow: (hours: number) => void;
}) {
  const retry = (key: keyof WebhookSpec['retry'], value: number) =>
    onChange({ ...spec, retry: { ...spec.retry, [key]: value } });
  return (
    <FormSection
      title="Delivery"
      description="A failed delivery is retried with the same idempotency key, doubling the wait each time."
    >
      <NumberField
        id="queue-timeout"
        label="Wait for each attempt"
        unit="ms"
        min={200}
        max={10000}
        error={errors['webhook.timeoutMs']}
        value={spec.timeoutMs}
        onChange={(timeoutMs) => onChange({ ...spec, timeoutMs })}
      />
      <NumberField id="queue-attempts" label="Attempts" min={1} max={5} error={errors['webhook.retry.attempts']} value={spec.retry.attempts} onChange={(v) => retry('attempts', v)} />
      <NumberField id="queue-base" label="First retry after" unit="ms" min={100} max={5000} value={spec.retry.baseMs} onChange={(v) => retry('baseMs', v)} />
      <NumberField id="queue-max-delay" label="Longest pause" unit="ms" min={100} max={10000} value={spec.retry.maxMs} onChange={(v) => retry('maxMs', v)} />
      <NumberField
        id="queue-deadline"
        label="Give up after"
        unit="ms"
        min={1000}
        max={60000}
        help="All attempts together. The caller's hold also bounds it."
        value={spec.retry.deadlineMs}
        onChange={(v) => retry('deadlineMs', v)}
      />
      <SwitchField
        label="Tell the third party when the caller gives up"
        checked={spec.cancel}
        help="One best-effort cancellation post when the hold times out or the caller hangs up."
        onChange={(cancel) => onChange({ ...spec, cancel })}
      />
      <NumberField
        id="queue-window"
        label="Accept later callbacks for"
        unit="hours"
        min={1}
        max={168}
        help="Accepted, released and outcome callbacks are recorded on the call after it was handed on."
        value={callbackWindowHours}
        onChange={onWindow}
      />
    </FormSection>
  );
}
