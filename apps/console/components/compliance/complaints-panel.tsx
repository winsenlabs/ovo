'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { dueLabel, failureText, type Complaint } from './compliance-types';

const NEXT: Record<Complaint['status'], Complaint['status'][]> = {
  open: ['acknowledged', 'represented', 'resolved'],
  acknowledged: ['represented', 'resolved'],
  represented: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

/**
 * Customer complaints and telco notices with their SLA timers: a customer complaint is
 * acknowledged within 24 hours and resolved within 7 days, a telco notice answered within 5
 * business days (defaults; see the runbook).
 */
export function ComplaintsPanel({
  complaints,
  canEdit,
  onChanged,
}: {
  complaints: Complaint[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  async function act(write: () => Promise<unknown>) {
    try {
      await write();
      setError(undefined);
      await onChanged();
    } catch (failure) {
      setError(failureText(failure, 'The complaint could not be updated.'));
    }
  }
  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const text = (name: string) => String(values.get(name) ?? '').trim();
    void act(async () => {
      await apiRequest('/operations/compliance/complaints', {
        method: 'POST',
        body: JSON.stringify({
          kind: text('kind'),
          ...(text('phoneNumber') ? { phoneNumber: text('phoneNumber') } : {}),
          ...(text('oapRef') ? { oapRef: text('oapRef') } : {}),
          receivedAt: new Date(text('receivedAt')).toISOString(),
          ...(text('summary') ? { summary: text('summary') } : {}),
        }),
      });
      form.reset();
    });
  }
  const move = (id: string, status: Complaint['status']) =>
    act(() =>
      apiRequest(`/operations/compliance/complaints/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    );
  return (
    <Panel labelledBy="complaints-title">
      <PanelHeader
        id="complaints-title"
        title="Complaints and notices"
        badge={
          <StatusBadge tone={complaints.some((row) => row.overdue) ? 'danger' : 'soft'}>
            {complaints.filter((row) => row.overdue).length} overdue
          </StatusBadge>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {!complaints.length ? (
        <div className="panel-body">
          <EmptyState title="No open complaints">
            New complaints and telco notices appear here.
          </EmptyState>
        </div>
      ) : (
        <ResponsiveTable label="Open complaints">
          <thead>
            <tr>
              <th>Received</th>
              <th>Kind</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {complaints.map((row) => (
              <tr key={row.id}>
                <td>
                  {new Date(row.receivedAt).toLocaleString()}
                  {row.phoneNumber && <small className="mono">{row.phoneNumber}</small>}
                  {row.summary && <small>{row.summary}</small>}
                </td>
                <td>{row.kind.replace('_', ' ')}</td>
                <td>
                  <StatusBadge tone={row.overdue ? 'danger' : 'neutral'}>
                    {row.overdue === 'ack' && row.ackDueAt
                      ? `Acknowledgement ${dueLabel(row.ackDueAt)}`
                      : `Resolution ${dueLabel(row.resolveDueAt)}`}
                  </StatusBadge>
                </td>
                <td>
                  {row.status}
                  <div className="button-row">
                    {NEXT[row.status].map((status) => (
                      <button
                        key={status}
                        className="button small"
                        disabled={!canEdit}
                        onClick={() => void move(row.id, status)}
                      >
                        Mark {status}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      )}
      <form className="panel-body form-grid" onSubmit={open}>
        <fieldset disabled={!canEdit} className="form-grid">
          <Field label="Kind" htmlFor="complaint-kind">
            <select id="complaint-kind" name="kind" defaultValue="customer">
              <option value="customer">Customer complaint</option>
              <option value="oap_notice">Telco (OAP) notice</option>
              <option value="ai_flag_notice">Spam-flag notice</option>
              <option value="appeal">Appeal</option>
              <option value="regulator">Regulator</option>
            </select>
          </Field>
          <Field
            label="Complainant's number"
            htmlFor="complaint-phone"
            help="A customer's number is put on the do-not-call list while the complaint is open."
          >
            <input id="complaint-phone" name="phoneNumber" type="tel" />
          </Field>
          <Field label="Telco reference" htmlFor="complaint-ref">
            <input id="complaint-ref" name="oapRef" />
          </Field>
          <Field label="Received" htmlFor="complaint-received">
            <input id="complaint-received" name="receivedAt" type="datetime-local" required />
          </Field>
          <Field label="Summary" htmlFor="complaint-summary">
            <input id="complaint-summary" name="summary" maxLength={2000} />
          </Field>
          <button className="button align-start">Open complaint</button>
        </fieldset>
      </form>
    </Panel>
  );
}
