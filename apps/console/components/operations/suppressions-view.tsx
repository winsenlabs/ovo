'use client';
import { useConfirm } from '../ui/dialog';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import type { SuppressionRecord } from '../../lib/operator-api';
import { useFormAction } from '../forms/use-form-action';
import { EmptyState, Field, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';
import { DoNotCallImport } from './do-not-call-import';
import { DoNotCallLookup } from './do-not-call-lookup';

/** A do-not-call entry: who listed it, and the call a caller opted out in. */
type DoNotCallEntry = SuppressionRecord & {
  source?: 'manual' | 'import' | 'opt_out';
  callId?: string;
};
const SOURCE_LABEL = { manual: 'Operator', import: 'Bulk import', opt_out: 'Caller opted out' };

export function SuppressionsView({ role }: { role: SessionIdentity['role'] }) {
  const formAction = useFormAction();
  const confirm = useConfirm();
  const [rows, setRows] = useState<DoNotCallEntry[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows(
        items<DoNotCallEntry>(
          (await apiRequest<unknown>('/operations/suppressions?limit=100')).data,
        ),
      );
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'The do-not-call list is not configured on this installation.'
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
    setBusy(true);
    setError(undefined);
    try {
      await formAction(event, async (values) => {
        await apiRequest('/operations/suppressions', {
          method: 'POST',
          body: JSON.stringify({
            phoneNumber: values.get('phoneNumber'),
            reason: values.get('reason'),
          }),
        });
        await load();
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Suppression could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(row: DoNotCallEntry) {
    if (
      !(await confirm(
        'Remove from the do-not-call list',
        row.source === 'opt_out'
          ? `${row.phoneNumber} asked not to be called again. Remove it only with the caller's renewed consent; the number may become eligible immediately.`
          : `Remove ${row.phoneNumber} from the do-not-call list? The number may become eligible immediately.`,
      ))
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
          <h1>Do-not-call list</h1>
          <p className="muted">
            Campaign admission, manual and test calls refuse a listed number, and the worker
            rechecks it immediately before every carrier dial. Callers who say &ldquo;stop calling
            me&rdquo; are added automatically.
          </p>
        </div>
        <button className="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      <Panel labelledBy="suppression-add-title">
        <PanelHeader
          id="suppression-add-title"
          title="Add a number"
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
            {busy ? 'Saving…' : 'Add number'}
          </button>
        </form>
      </Panel>
      <DoNotCallImport role={role} onImported={load} />
      <DoNotCallLookup />
      <Panel labelledBy="suppression-list-title">
        <PanelHeader
          id="suppression-list-title"
          title="Listed numbers"
          badge={<StatusBadge>{rows.length}</StatusBadge>}
        />
        {!rows.length ? (
          <div className="panel-body">
            <EmptyState title="No listed numbers returned">
              The API returned an empty list. This does not bypass campaign-level attempt limits.
            </EmptyState>
          </div>
        ) : (
          <ResponsiveTable label="Do-not-call numbers">
            <thead>
              <tr>
                <th>Phone number</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.phoneNumber}>
                  <td className="mono">{row.phoneNumber}</td>
                  <td>{row.reason}</td>
                  <td>
                    {row.source ? SOURCE_LABEL[row.source] : SOURCE_LABEL.manual}
                    {row.callId && <small className="mono">{row.callId}</small>}
                  </td>
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
