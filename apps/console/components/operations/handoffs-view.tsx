'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type CallSummary, type SessionIdentity } from '../../lib/api';
import type { HandoffRecord } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  JsonEvidence,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { InboundPolicy } from './inbound-policy';
import { InboundRoutes } from './inbound-routes';
import { HandoffRequestPanel } from './handoff-request-panel';

export function HandoffsView({ role }: { role: SessionIdentity['role'] }) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [targetKind, setTargetKind] = useState<'phone' | 'queue'>('phone');
  const [fallbackKind, setFallbackKind] = useState<'resume' | 'end' | 'human'>('resume');
  const [lookupId, setLookupId] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const loadCalls = useCallback(async () => {
    try {
      setCalls(
        items<CallSummary>((await apiRequest<unknown>('/calls')).data).filter(
          (call) => call.kind === 'live' && !call.completedAt,
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Live calls unavailable.');
    }
  }, []);
  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);
  const upsert = (record: HandoffRecord) =>
    setHandoffs((current) => [record, ...current.filter((item) => item.id !== record.id)]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    const fallback =
      fallbackKind === 'human'
        ? {
            kind: fallbackKind,
            target: values.get('fallbackTarget'),
            message: values.get('fallbackMessage'),
          }
        : { kind: fallbackKind, message: values.get('fallbackMessage') };
    try {
      upsert(
        (
          await apiRequest<HandoffRecord>('/operations/handoffs', {
            method: 'POST',
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              callId: values.get('callId'),
              target: { kind: targetKind, value: values.get('target') },
              fallback,
              confirmationRequired: values.get('confirmationRequired') === 'on',
            }),
          })
        ).data,
      );
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Handoff operations are not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Handoff could not be requested.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function lookup(id = lookupId) {
    if (!id) return;
    setBusy(true);
    setError(undefined);
    try {
      upsert((await apiRequest<HandoffRecord>(`/operations/handoffs/${id}`)).data);
      setLookupId('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Handoff not found.');
    } finally {
      setBusy(false);
    }
  }
  async function confirm(record: HandoffRecord, accepted: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      upsert(
        (
          await apiRequest<HandoffRecord>(`/operations/handoffs/${record.id}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ accepted }),
          })
        ).data,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Confirmation failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Live call control</p>
          <h1>Handoffs & inbound</h1>
          <p className="muted">
            A handoff is confirmed only by a provider receipt; unknown outcomes remain unknown and
            are never blindly retried.
          </p>
        </div>
        <button className="button" onClick={() => void loadCalls()}>
          Refresh calls
        </button>
      </header>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      <HandoffRequestPanel
        calls={calls}
        targetKind={targetKind}
        setTargetKind={setTargetKind}
        fallbackKind={fallbackKind}
        setFallbackKind={setFallbackKind}
        role={role}
        busy={busy}
        create={create}
      />
      <Panel labelledBy="handoff-evidence-title">
        <PanelHeader
          id="handoff-evidence-title"
          title="Handoff evidence"
          badge={<StatusBadge>{handoffs.length} loaded</StatusBadge>}
        />
        <div className="panel-body stack">
          <div className="form-grid">
            <Field label="Load handoff by ID" htmlFor="handoff-lookup">
              <input
                id="handoff-lookup"
                value={lookupId}
                onChange={(event) => setLookupId(event.target.value)}
              />
            </Field>
            <button
              className="button align-start"
              type="button"
              disabled={!lookupId || busy}
              onClick={() => void lookup()}
            >
              Load evidence
            </button>
          </div>
          {!handoffs.length ? (
            <EmptyState title="No handoffs loaded">
              Request a handoff or load its persisted ID. The API does not expose a broad handoff
              listing endpoint.
            </EmptyState>
          ) : (
            <ResponsiveTable label="Loaded handoff evidence">
              <thead>
                <tr>
                  <th>Handoff</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th>Provider evidence</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {handoffs.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <span className="mono">{record.id}</span>
                      <small>Call {record.callId}</small>
                    </td>
                    <td>
                      {record.target.kind}: {record.target.value}
                      <small>Fallback: {record.fallback.kind}</small>
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          record.status === 'confirmed' || record.status === 'fallback_completed'
                            ? 'good'
                            : /failed|unknown/.test(record.status)
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {record.status}
                      </StatusBadge>
                      <small>
                        attempt {record.attempt} · fallback {record.fallbackAttempt}
                      </small>
                    </td>
                    <td>
                      {record.providerReceiptId ? (
                        <span className="mono">{record.providerReceiptId}</span>
                      ) : (
                        'No confirmed receipt'
                      )}
                      {record.lastError && (
                        <small className="danger-text">{record.lastError}</small>
                      )}
                      <JsonEvidence label="Persisted handoff record" value={record} />
                    </td>
                    <td>
                      <div className="button-row">
                        {record.status === 'awaiting_confirmation' && (
                          <>
                            <button
                              className="button small primary"
                              disabled={role === 'viewer' || busy}
                              onClick={() => void confirm(record, true)}
                            >
                              Accept
                            </button>
                            <button
                              className="button small danger"
                              disabled={role === 'viewer' || busy}
                              onClick={() => void confirm(record, false)}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        <button
                          className="button small"
                          disabled={busy}
                          onClick={() => void lookup(record.id)}
                        >
                          Refresh
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          )}
        </div>
      </Panel>
      <InboundRoutes role={role} />
      <InboundPolicy role={role} />
    </div>
  );
}
