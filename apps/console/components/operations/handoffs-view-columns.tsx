import type { CallSummary, SessionIdentity } from '../../lib/api';
import type { HandoffRecord } from '../../lib/operator-api';
import type { ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { JsonViewer } from '../ui/code-block';
import { Duration } from '../ui/display';
import type { ReleaseOption } from './agent-release-options';

/** Maps a live call's `releaseId` to the agent that owns it, the same lookup Inbound uses —
 * call rows never carry a populated `agentId` even though the type allows one. */
function callAgentName(call: CallSummary, releases: readonly ReleaseOption[]): string | undefined {
  return releases.find((release) => release.id === call.releaseId)?.agentName;
}

/** Still running right now, live (not simulation). */
function liveDuration(call: CallSummary): number | undefined {
  return call.createdAt ? Date.now() - new Date(call.createdAt).getTime() : undefined;
}

function InlineError({ text }: { text: string }) {
  return (
    <>
      <br />
      <small className="danger-text">{text}</small>
    </>
  );
}

/** The "Live calls now" table's columns. Split out of `HandoffsView` purely to keep that module
 * under the size gate. */
export function liveCallColumns({
  role,
  releases,
  onRequest,
}: {
  role: SessionIdentity['role'];
  releases: readonly ReleaseOption[];
  onRequest: (call: CallSummary) => void;
}): ColumnV2<CallSummary>[] {
  return [
    {
      id: 'id',
      header: 'Call',
      cell: (call) => (
        <IdChip id={call.id} short={call.id.slice(0, 12)} href={`/calls/${call.id}`} />
      ),
    },
    {
      id: 'agent',
      header: 'Agent',
      cell: (call) => callAgentName(call, releases) ?? <span className="ds-unknown">Unknown</span>,
    },
    { id: 'status', header: 'Status', cell: (call) => <StatusBadgeV2 value={call.status} /> },
    {
      id: 'duration',
      header: 'Running for',
      cell: (call) => <Duration ms={liveDuration(call)} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (call) => (
        <button
          className="button small primary"
          type="button"
          onClick={() => onRequest(call)}
          disabled={role === 'viewer'}
        >
          Request handoff
        </button>
      ),
    },
  ];
}

/** The "Session handoffs" table's columns. Split out of `HandoffsView` purely to keep that
 * module under the size gate. */
export function sessionHandoffColumns({
  role,
  busy,
  onConfirm,
  onRefresh,
}: {
  role: SessionIdentity['role'];
  busy: boolean;
  onConfirm: (record: HandoffRecord, accepted: boolean) => void;
  onRefresh: (id: string) => void;
}): ColumnV2<HandoffRecord>[] {
  return [
    {
      id: 'id',
      header: 'Handoff',
      cell: (record) => (
        <>
          <IdChip id={record.id} short={record.id.slice(0, 10)} />
          <br />
          <small className="muted">Call {record.callId}</small>
        </>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      // Optional chaining, not a direct read: some server responses to a handoff action (e.g. a
      // bare 202/204) carry no `target`/`fallback` at all, and `record.target.kind` on a missing
      // target crashed the whole table (brief defect #15) instead of just this one cell.
      cell: (record) => (
        <>
          {record.target?.kind ?? 'Unknown target'}
          {record.target?.value ? `: ${record.target.value}` : ''}
          <br />
          <small className="muted">Fallback: {record.fallback?.kind ?? 'Unknown'}</small>
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (record) => (
        <>
          <StatusBadgeV2 value={record.status} />
          <br />
          <small className="muted">
            attempt {record.attempt} · fallback {record.fallbackAttempt}
          </small>
        </>
      ),
    },
    {
      id: 'evidence',
      header: 'Provider evidence',
      cell: (record) => (
        <>
          {record.providerReceiptId ? (
            <span className="mono">{record.providerReceiptId}</span>
          ) : (
            <span className="ds-unknown">No confirmed receipt</span>
          )}
          {record.lastError && <InlineError text={record.lastError} />}
          <JsonViewer label="Persisted handoff record" value={record} />
        </>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (record) => (
        <div className="button-row">
          {record.status === 'awaiting_confirmation' && (
            <>
              <button
                className="button small primary"
                disabled={role === 'viewer' || busy}
                onClick={() => onConfirm(record, true)}
              >
                Accept
              </button>
              <button
                className="button small danger"
                disabled={role === 'viewer' || busy}
                onClick={() => onConfirm(record, false)}
              >
                Reject
              </button>
            </>
          )}
          <button className="button small" disabled={busy} onClick={() => onRefresh(record.id)}>
            Refresh
          </button>
        </div>
      ),
    },
  ];
}
