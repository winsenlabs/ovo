'use client';
import { useState } from 'react';
import { apiRequest, type CallSummary, type SessionIdentity } from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { CodeBlock } from '../ui/code-block';
import { InlineAlert } from '../ui/feedback-v2';

type ExportJob = {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt?: string;
  updatedAt?: string;
  sha256?: string;
};

const operationId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `export-${Date.now()}`;

/** Durable, integrity-checked redacted export of a recording's evidence, queued asynchronously
 * from the Recording files tab. */
export function RecordingExportPanel({
  call,
  recordingId,
  role,
}: {
  call: CallSummary;
  recordingId: string;
  role: SessionIdentity['role'];
}) {
  const [job, setJob] = useState<ExportJob>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const base = `/calls/${encodeURIComponent(call.id)}/live-recordings/${encodeURIComponent(recordingId)}`;

  async function requestExport() {
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<ExportJob>(`${base}/exports`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: operationId() }),
      });
      setJob(data);
    } catch (next) {
      setError(next instanceof Error ? next.message : 'The redacted export could not be queued.');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!job) return;
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<ExportJob>(`${base}/exports/${encodeURIComponent(job.id)}`);
      setJob(data);
    } catch (next) {
      setError(next instanceof Error ? next.message : 'Export status could not be refreshed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Durable redacted export"
      description="Exports are asynchronous, integrity-checked operator artifacts."
      actions={job && <StatusBadgeV2 value={job.state} />}
    >
      <div className="ui-cluster">
        {role !== 'viewer' && (
          <button type="button" className="button" onClick={requestExport} disabled={busy}>
            {busy && !job ? 'Queueing…' : 'Request redacted export'}
          </button>
        )}
        {job && (
          <button type="button" className="button" onClick={refresh} disabled={busy}>
            Refresh status
          </button>
        )}
        {job?.state === 'succeeded' && (
          <a
            className="button"
            href={`/api/v1${base}/exports/${encodeURIComponent(job.id)}/download`}
            download
          >
            Download export
          </a>
        )}
      </div>
      {job && (
        <CodeBlock code={() => JSON.stringify(job, null, 2)} collapsedLabel="Export receipt" />
      )}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
    </SectionCard>
  );
}
