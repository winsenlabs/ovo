'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import type { SuppressionRecord } from '../../lib/operator-api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

export function SuppressionsView({ role }: { role: SessionIdentity['role'] }) {
  const [rows, setRows] = useState<SuppressionRecord[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows(
        items<SuppressionRecord>(
          (await apiRequest<unknown>('/operations/suppressions?limit=100')).data,
        ),
      );
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'Suppression operations are not configured on this installation.'
          : failure instanceof Error
            ? failure.message
            : 'Suppressions unavailable.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await apiRequest('/operations/suppressions', {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: values.get('phoneNumber'),
          reason: values.get('reason'),
        }),
      });
      event.currentTarget.reset();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Suppression could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(row: SuppressionRecord) {
    if (
      !window.confirm(
        `Remove suppression for ${row.phoneNumber}? The number may become eligible immediately.`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await apiRequest(`/operations/suppressions/${encodeURIComponent(row.phoneNumber)}`, {
        method: 'DELETE',
      });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Suppression could not be removed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Dial safety</p>
          <h1>Suppressions</h1>
          <p className="muted">
            The worker rechecks this persisted list immediately before every carrier dial.
          </p>
        </div>
        <button className="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {error && (
        <Notice tone="warning" live>
          {error}
        </Notice>
      )}
      <Panel labelledBy="suppression-add-title">
        <PanelHeader
          id="suppression-add-title"
          title="Suppress a number"
          badge={<StatusBadge tone="warning">Immediate gate</StatusBadge>}
        />
        <form className="panel-body form-grid" onSubmit={add}>
          <Field label="E.164 phone number" htmlFor="suppression-phone">
            <input
              id="suppression-phone"
              name="phoneNumber"
              type="tel"
              placeholder="+91…"
              required
            />
          </Field>
          <Field label="Reason" htmlFor="suppression-reason">
            <input id="suppression-reason" name="reason" required maxLength={1000} />
          </Field>
          <button className="button primary align-start" disabled={role === 'viewer' || busy}>
            {busy ? 'Saving…' : 'Add suppression'}
          </button>
        </form>
      </Panel>
      <Panel labelledBy="suppression-list-title">
        <PanelHeader
          id="suppression-list-title"
          title="Active suppressions"
          badge={<StatusBadge>{rows.length}</StatusBadge>}
        />
        {!rows.length ? (
          <div className="panel-body">
            <EmptyState title="No suppressions returned">
              The API returned an empty list. This does not bypass campaign-level attempt limits.
            </EmptyState>
          </div>
        ) : (
          <ResponsiveTable label="Suppressed phone numbers">
            <thead>
              <tr>
                <th>Phone number</th>
                <th>Reason</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.phoneNumber}>
                  <td className="mono">{row.phoneNumber}</td>
                  <td>{row.reason}</td>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>
                    <button
                      className="button small danger"
                      disabled={role === 'viewer' || busy}
                      onClick={() => void remove(row)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </Panel>
    </div>
  );
}
