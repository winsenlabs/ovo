'use client';
import { useState, type CSSProperties, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { SectionCard } from '../ui/section-card';
import { Drawer } from '../ui/drawer';
import { formatDateTime } from '../../lib/format';
import { complaintKindLabel, dueLabel, failureText, type Complaint } from './compliance-types';

const NEXT: Record<Complaint['status'], Complaint['status'][]> = {
  open: ['acknowledged', 'represented', 'resolved'],
  acknowledged: ['represented', 'resolved'],
  represented: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

// See cli-registry-panel.tsx: flattens the browser's native fieldset chrome.
const FLAT_FIELDSET: CSSProperties = { border: 0, margin: 0, padding: 0 };

/**
 * Customer complaints and telco notices with their SLA timers: a customer complaint is
 * acknowledged within 24 hours and resolved within 7 days, a telco notice answered within 5
 * business days (defaults; see the runbook). Opening one puts it in a drawer, not an always-open
 * form above the table.
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
  const [adding, setAdding] = useState(false);
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
      setAdding(false);
    });
  }
  const move = (id: string, status: Complaint['status']) =>
    act(() =>
      apiRequest(`/operations/compliance/complaints/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    );

  const overdueCount = complaints.filter((row) => row.overdue).length;
  const sorted = [...complaints].sort((a, b) => {
    if (Boolean(a.overdue) !== Boolean(b.overdue)) return a.overdue ? -1 : 1;
    return Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
  });

  const columns: ColumnV2<Complaint>[] = [
    {
      id: 'received',
      header: 'Received',
      cell: (row) => (
        <>
          {formatDateTime(row.receivedAt)}
          {row.phoneNumber && (
            <>
              <br />
              <small className="mono">{row.phoneNumber}</small>
            </>
          )}
          {row.summary && (
            <>
              <br />
              <small className="muted">{row.summary}</small>
            </>
          )}
        </>
      ),
      sortValue: (row) => row.receivedAt,
    },
    { id: 'kind', header: 'Kind', cell: (row) => complaintKindLabel(row.kind) },
    {
      id: 'due',
      header: 'Due',
      cell: (row) => (
        <StatusBadgeV2
          tone={row.overdue ? 'danger' : 'neutral'}
          label={
            row.overdue === 'ack' && row.ackDueAt
              ? `Acknowledgement ${dueLabel(row.ackDueAt)}`
              : `Resolution ${dueLabel(row.resolveDueAt)}`
          }
        />
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <>
          <StatusBadgeV2 value={row.status} />
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
        </>
      ),
    },
  ];

  return (
    <div className="stack">
      <SectionCard
        title="Complaints and notices"
        padding="flush"
        actions={
          <div className="button-row">
            <StatusBadgeV2
              tone={overdueCount ? 'danger' : 'neutral'}
              label={`${overdueCount} overdue`}
            />
            <button
              className="button small primary"
              type="button"
              onClick={() => setAdding(true)}
              disabled={!canEdit}
            >
              Open complaint
            </button>
          </div>
        }
      >
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <DataTableV2
          key={sorted.length === 0 ? 'empty' : 'data'}
          label="Complaints and notices"
          rows={sorted}
          columns={columns}
          rowKey={(row) => row.id}
          empty={
            <EmptyStateV2 title="No open complaints">
              New complaints and telco notices appear here.
            </EmptyStateV2>
          }
        />
      </SectionCard>
      <Drawer open={adding} onClose={() => setAdding(false)} title="Open complaint">
        <form className="form-grid" onSubmit={open}>
          <fieldset disabled={!canEdit} className="form-grid" style={FLAT_FIELDSET}>
            <FormField id="complaint-kind" label="Kind">
              {(control) => (
                <select {...control} name="kind" defaultValue="customer">
                  <option value="customer">Customer complaint</option>
                  <option value="oap_notice">Telco (OAP) notice</option>
                  <option value="ai_flag_notice">Spam-flag notice</option>
                  <option value="appeal">Appeal</option>
                  <option value="regulator">Regulator</option>
                </select>
              )}
            </FormField>
            <FormField
              id="complaint-phone"
              label="Complainant's number"
              help="A customer's number is put on the do-not-call list while the complaint is open."
            >
              {(control) => <input {...control} name="phoneNumber" type="tel" />}
            </FormField>
            <FormField id="complaint-ref" label="Telco reference">
              {(control) => <input {...control} name="oapRef" />}
            </FormField>
            <FormField id="complaint-received" label="Received">
              {(control) => <input {...control} name="receivedAt" type="datetime-local" required />}
            </FormField>
            <FormField id="complaint-summary" label="Summary">
              {(control) => <input {...control} name="summary" maxLength={2000} />}
            </FormField>
            <button className="button primary align-start" style={{ alignSelf: 'start' }}>
              Submit
            </button>
          </fieldset>
        </form>
      </Drawer>
    </div>
  );
}
