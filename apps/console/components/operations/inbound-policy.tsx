'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, type SessionIdentity } from '../../lib/api';
import { Field, JsonEvidence, Panel, PanelHeader, StatusBadge } from '../primitives';

type Policy =
  | { kind: 'busy'; reason: string }
  | { kind: 'wait'; maxWaitMs: number; announcement: string }
  | { kind: 'callback'; queue: string; announcement: string }
  | { kind: 'human'; target: string; announcement: string };
interface PolicyRecord {
  version: number;
  policy: Policy;
}

export function InboundPolicy({ role }: { role: SessionIdentity['role'] }) {
  const [record, setRecord] = useState<PolicyRecord>();
  const [kind, setKind] = useState<Policy['kind']>('busy');
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState('');
  const [maxWaitMs, setMaxWaitMs] = useState('30000');
  const [capacity, setCapacity] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [policy, ready] = await Promise.all([
        apiRequest<{ policy: PolicyRecord | null }>('/operations/inbound/policy'),
        apiRequest<{ readyProtected: number }>('/operations/inbound/capacity'),
      ]);
      const next = policy.data.policy ?? undefined;
      setRecord(next);
      setCapacity(ready.data.readyProtected);
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
        failure instanceof ApiError && failure.status === 503
          ? 'Inbound operations are not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Inbound policy unavailable.',
      );
    }
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
    <Panel labelledBy="inbound-policy-title">
      <PanelHeader
        id="inbound-policy-title"
        title="Inbound overflow policy"
        badge={
          <StatusBadge tone={capacity ? 'good' : 'warning'}>
            {capacity === undefined ? 'Unknown capacity' : `${capacity} protected ready`}
          </StatusBadge>
        }
      />
      <form className="panel-body stack" onSubmit={save}>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="muted">
          Only ready, reserved and task-protected capacity is counted. Zero capacity executes this
          policy rather than claiming readiness. Wait uses bounded signed carrier polls and hangs up
          when its persisted deadline expires. Callback requires signed caller DTMF consent and
          enters the normal suppression, quota and outbox path; it fails closed unless live outbound
          calling is enabled for the called number.
        </div>
        <div className="form-grid">
          <Field label="Overflow action" htmlFor="inbound-kind">
            <select
              id="inbound-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as Policy['kind'])}
            >
              <option value="busy">Busy</option>
              <option value="wait">Wait with bounded timeout</option>
              <option value="callback">Callback with caller consent</option>
              <option value="human">Human target</option>
            </select>
          </Field>
          {kind === 'wait' && (
            <Field label="Maximum wait (ms)" htmlFor="inbound-wait">
              <input
                id="inbound-wait"
                type="number"
                min={1000}
                max={300000}
                value={maxWaitMs}
                onChange={(event) => setMaxWaitMs(event.target.value)}
              />
            </Field>
          )}
          {(kind === 'callback' || kind === 'human') && (
            <Field
              label={kind === 'callback' ? 'Callback queue' : 'Human target'}
              htmlFor="inbound-target"
            >
              <input
                id="inbound-target"
                required
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </Field>
          )}
          <Field
            label={kind === 'busy' ? 'Busy reason' : 'Caller announcement'}
            htmlFor="inbound-message"
          >
            <textarea
              id="inbound-message"
              required
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </Field>
        </div>
        <div className="button-row">
          <button className="button primary" disabled={role !== 'admin' || busy}>
            {busy ? 'Saving…' : 'Save policy'}
          </button>
          <button className="button" type="button" onClick={() => void load()}>
            Reload
          </button>
        </div>
        {record && (
          <JsonEvidence label={`Persisted policy v${record.version}`} value={record.policy} />
        )}
      </form>
    </Panel>
  );
}
