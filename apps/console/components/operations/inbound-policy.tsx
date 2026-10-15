'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import { apiFailureMessage } from '../../lib/data/use-list';
import { RadioCardGroup } from '../ui/choice-card';
import { FormField } from '../ui/form-field';
import { StatusBadgeV2 } from '../ui/status-badge';
import { JsonViewer } from '../ui/code-block';
import { ErrorState, SkeletonTableRows } from '../ui/feedback-v2';
import { SectionCard } from '../ui/section-card';
import { ReadinessCard, type Capacity, type InboundReadiness } from './inbound-readiness-card';
import { formatDuration } from '../../lib/format';

export type { Capacity, InboundReadiness };

export type PolicyKind = 'busy' | 'wait' | 'callback' | 'human';
export type Policy =
  | { kind: 'busy'; reason: string }
  | { kind: 'wait'; maxWaitMs: number; announcement: string }
  | { kind: 'callback'; queue: string; announcement: string }
  | { kind: 'human'; target: string; announcement: string };
interface PolicyRecord {
  version: number;
  policy: Policy;
}

const KIND_CHOICES = [
  { value: 'busy', title: 'Busy', description: 'Play a reason and end the call.' },
  { value: 'wait', title: 'Wait', description: 'Hold with a bounded, signed carrier poll.' },
  {
    value: 'callback',
    title: 'Callback',
    description: 'Offer a callback; needs signed caller DTMF consent.',
  },
  { value: 'human', title: 'Human target', description: 'Transfer to a standby human line.' },
] as const;

/**
 * The inbound overflow policy (what happens when no ready, protected worker can answer) plus the
 * dispatcher's readiness report. Self-contained: embedded as a section of the Inbound page, it
 * loads and saves on its own; `onReadiness` lets that page mirror the capacity count into its own
 * KPI strip without lifting this component's state.
 */
export function InboundPolicy({
  role,
  onReadiness,
}: {
  role: SessionIdentity['role'];
  onReadiness?: (capacity: Capacity) => void;
}) {
  const [record, setRecord] = useState<PolicyRecord>();
  const [kind, setKind] = useState<PolicyKind>('busy');
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState('');
  const [maxWaitMs, setMaxWaitMs] = useState('30000');
  const [capacity, setCapacity] = useState<number>();
  const [readiness, setReadiness] = useState<InboundReadiness | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [policy, ready] = await Promise.all([
        apiRequest<{ policy: PolicyRecord | null }>('/operations/inbound/policy'),
        apiRequest<Capacity>('/operations/inbound/capacity'),
      ]);
      const next = policy.data.policy ?? undefined;
      setRecord(next);
      setCapacity(ready.data.readyProtected);
      // Absent: this API cannot read readiness at all, so nothing is shown.
      setReadiness(ready.data.readiness);
      onReadiness?.(ready.data);
      setError(undefined);
      if (next) {
        setKind(next.policy.kind);
        setMessage('reason' in next.policy ? next.policy.reason : next.policy.announcement);
        setTarget(
          'queue' in next.policy
            ? next.policy.queue
            : 'target' in next.policy
              ? next.policy.target
              : '',
        );
        if ('maxWaitMs' in next.policy) setMaxWaitMs(String(next.policy.maxWaitMs));
      }
    } catch (failure) {
      setError(
        apiFailureMessage(
          failure,
          'Inbound operations are not configured.',
          'Inbound policy unavailable.',
        ),
      );
    } finally {
      setLoading(false);
    }
    // `onReadiness` is a fresh closure on every parent render; re-running load from it would
    // refetch on every keystroke upstream, so it is intentionally left out of the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const policy: Policy =
      kind === 'busy'
        ? { kind, reason: message }
        : kind === 'wait'
          ? { kind, maxWaitMs: Number(maxWaitMs), announcement: message }
          : kind === 'callback'
            ? { kind, queue: target, announcement: message }
            : { kind, target, announcement: message };
    try {
      await apiRequest('/operations/inbound/policy', {
        method: 'PUT',
        body: JSON.stringify({ expectedVersion: record?.version ?? null, policy }),
      });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Inbound policy could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SectionCard
      title="Overflow policy"
      description="What happens to a caller when no ready, protected worker can answer."
      actions={
        !loading && (
          <StatusBadgeV2
            tone={capacity ? 'ok' : 'warn'}
            label={capacity === undefined ? 'Unknown capacity' : `${capacity} protected ready`}
          />
        )
      }
    >
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading ? (
        <SkeletonTableRows rows={4} columns={1} />
      ) : (
        <form className="stack" onSubmit={save}>
          <p className="muted">
            Only ready, reserved and task-protected capacity is counted. Zero capacity executes this
            policy rather than claiming readiness. Wait uses bounded signed carrier polls and hangs
            up when its persisted deadline expires. Callback requires signed caller DTMF consent and
            enters the normal suppression, quota and outbox path; it fails closed unless live
            outbound calling is enabled for the called number.
          </p>
          <ReadinessCard readiness={readiness} />
          <RadioCardGroup
            name="inbound-overflow-kind"
            groupLabel="Overflow action"
            value={kind}
            onChange={(value) => setKind(value as PolicyKind)}
            choices={KIND_CHOICES}
            columns={2}
          />
          {kind === 'wait' && (
            <FormField
              id="inbound-wait"
              label="Maximum wait (ms)"
              help={
                Number.isFinite(Number(maxWaitMs))
                  ? `${formatDuration(Number(maxWaitMs))} before giving up`
                  : undefined
              }
            >
              {(control) => (
                <input
                  {...control}
                  type="number"
                  min={1000}
                  max={300000}
                  value={maxWaitMs}
                  onChange={(event) => setMaxWaitMs(event.target.value)}
                />
              )}
            </FormField>
          )}
          {(kind === 'callback' || kind === 'human') && (
            <FormField
              id="inbound-target"
              label={kind === 'callback' ? 'Callback queue' : 'Human target'}
            >
              {(control) => (
                <input
                  {...control}
                  required
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                />
              )}
            </FormField>
          )}
          <FormField
            id="inbound-message"
            label={kind === 'busy' ? 'Busy reason' : 'Caller announcement'}
          >
            {(control) => (
              <textarea
                {...control}
                required
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            )}
          </FormField>
          <div className="button-row">
            <button className="button primary" disabled={role !== 'admin' || busy}>
              {busy ? 'Saving…' : 'Save policy'}
            </button>
            <button className="button" type="button" onClick={() => void load()}>
              Reload
            </button>
          </div>
          {record && (
            <JsonViewer label={`Persisted policy v${record.version}`} value={record.policy} />
          )}
        </form>
      )}
    </SectionCard>
  );
}
