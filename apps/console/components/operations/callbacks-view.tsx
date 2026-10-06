'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import { EmptyState, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';

export interface CallbackRecord {
  id: string;
  callId: string;
  dueAt: string;
  timezone: string;
  source: 'flow' | 'llm';
  node: string | null;
  disposition: string | null;
  reason: string | null;
  status: 'pending' | 'dialing' | 'dialed' | 'completed' | 'cancelled';
  dialedCallId: string | null;
  phone: string | null;
}

interface CallbackPage {
  available: boolean;
  items: CallbackRecord[];
  nextCursor: string | null;
}

const STATUSES = ['pending', 'dialing', 'dialed', 'completed', 'cancelled', 'all'] as const;
type Filter = (typeof STATUSES)[number];

/** The due time in the agent's own timezone, which is the caller's. */
function due(record: CallbackRecord): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: record.timezone,
    }).format(new Date(record.dueAt));
  } catch {
    // swallow-ok: an unknown timezone shows the instant as it is stored.
    return record.dueAt;
  }
}

/**
 * Callbacks agents promised on calls (AGT-15), soonest due first. Dialling one places a live call
 * to the same number with the same release and its variables; a callback handled another way is
 * marked completed, and one no longer wanted is cancelled.
 */
export function CallbacksView({
  role,
  now = () => new Date(),
}: {
  role: SessionIdentity['role'];
  now?: () => Date;
}) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [page, setPage] = useState<CallbackPage>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      const query = filter === 'all' ? '' : `?status=${filter}`;
      setPage((await apiRequest<CallbackPage>(`/callbacks${query}`)).data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Callbacks could not be loaded.');
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(record: CallbackRecord, action: 'dial' | 'complete' | 'cancel') {
    setBusy(record.id);
    setError(undefined);
    try {
      await apiRequest(`/callbacks/${record.id}/${action}`, { method: 'POST', body: '{}' });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Callback could not ${action}.`);
    } finally {
      setBusy(undefined);
    }
  }

  const admin = role === 'admin';
  return (
    <Panel labelledBy="callbacks-title">
      <PanelHeader
        id="callbacks-title"
        title="Callbacks"
        badge={<StatusBadge tone="soft">{page?.items.length ?? 0}</StatusBadge>}
      />
      <div className="panel-body stack">
        <p className="muted">
          Callbacks the agent promised on a call. Dialling one places a live call to the same number
          with the same release, subject to the live-call checks.
        </p>
        <div className="ui-cluster" role="group" aria-label="Callback status">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`button small${filter === status ? ' primary' : ''}`}
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
            >
              {status[0]!.toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        {page && !page.available ? (
          <EmptyState title="Callbacks need PostgreSQL">
            This installation keeps no durable call outcomes, so no callback is recorded.
          </EmptyState>
        ) : page && !page.items.length ? (
          <EmptyState title="No callbacks">No callback matches this filter.</EmptyState>
        ) : page ? (
          <ResponsiveTable label="Callbacks">
            <thead>
              <tr>
                <th>Due</th>
                <th>Number</th>
                <th>Promised by</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((record) => {
                const overdue =
                  record.status === 'pending' && new Date(record.dueAt).getTime() < now().getTime();
                return (
                  <tr key={record.id}>
                    <td>
                      {due(record)}
                      {overdue && <StatusBadge tone="warning">Overdue</StatusBadge>}
                    </td>
                    <td className="mono">{record.phone ?? 'unknown'}</td>
                    <td>
                      {record.source === 'llm' ? 'LLM' : `Flow · ${record.node ?? 'node'}`}
                      <small className="mono">
                        <a href={`/calls/${record.callId}`}>{record.callId}</a>
                      </small>
                    </td>
                    <td>
                      <StatusBadge tone={record.status === 'pending' ? 'warning' : 'soft'}>
                        {record.status}
                      </StatusBadge>
                      {record.dialedCallId && (
                        <small className="mono">
                          <a href={`/calls/${record.dialedCallId}`}>{record.dialedCallId}</a>
                        </small>
                      )}
                    </td>
                    <td>
                      <div className="button-row">
                        {(record.status === 'pending' || record.status === 'dialing') && (
                          <button
                            className="button small primary"
                            type="button"
                            disabled={!admin || busy !== undefined || !record.phone}
                            onClick={() => void act(record, 'dial')}
                          >
                            {busy === record.id ? 'Dialling…' : 'Call back now'}
                          </button>
                        )}
                        {record.status !== 'completed' && record.status !== 'cancelled' && (
                          <button
                            className="button small"
                            type="button"
                            disabled={!admin || busy !== undefined}
                            onClick={() => void act(record, 'complete')}
                          >
                            Mark done
                          </button>
                        )}
                        {(record.status === 'pending' || record.status === 'dialing') && (
                          <button
                            className="button small danger"
                            type="button"
                            disabled={!admin || busy !== undefined}
                            onClick={() => void act(record, 'cancel')}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
        ) : (
          <p className="muted">Loading callbacks…</p>
        )}
      </div>
    </Panel>
  );
}
