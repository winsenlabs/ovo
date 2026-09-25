'use client';
import { useState } from 'react';
import { apiRequest, type CallSummary, type SessionIdentity } from '../../lib/api';
import { JsonEvidence, StatusBadge } from '../primitives';

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
    <section className="subsection stack" aria-labelledby="recording-export-title">
      <div className="split-row">
        <div>
          <h4 id="recording-export-title">Durable redacted export</h4>
          <p className="muted">Exports are asynchronous, integrity-checked operator artifacts.</p>
        </div>
        {job && (
          <StatusBadge tone={job.state === 'succeeded' ? 'good' : 'soft'}>{job.state}</StatusBadge>
        )}
      </div>
      <div className="button-row">
        {role !== 'viewer' && (
          <button className="button" type="button" onClick={requestExport} disabled={busy}>
            {busy && !job ? 'Queueing…' : 'Request redacted export'}
          </button>
        )}
        {job && (
          <button className="button" type="button" onClick={refresh} disabled={busy}>
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
      {job && <JsonEvidence label="Export receipt" value={job} />}
      {error && <div className="field-error" role="alert">{error}</div>}
    </section>
  );
}
