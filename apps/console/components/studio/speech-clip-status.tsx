'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { Panel, PanelHeader, StatusBadge } from '../primitives';

/** `GET /v1/agents/:agentId/releases/:releaseId/speech-clips`. */
export interface SpeechClipStatus {
  state:
    | 'disabled'
    | 'unavailable'
    | 'not-requested'
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'skipped';
  total: number;
  ready: number;
  failed: number;
  pending: number;
  perCall: number;
  inventorySha256: string | null;
  detail: string | null;
  requestedAt: string | null;
  finishedAt: string | null;
}

type Load = (agentId: string, releaseId: string) => Promise<SpeechClipStatus>;

const loadStatus: Load = async (agentId, releaseId) =>
  (
    await apiRequest<SpeechClipStatus>(
      `/agents/${encodeURIComponent(agentId)}/releases/${encodeURIComponent(releaseId)}/speech-clips`,
    )
  ).data;

const LABELS: Record<SpeechClipStatus['state'], string> = {
  disabled: 'Cache off',
  unavailable: 'No clip store',
  'not-requested': 'Not pre-rendered',
  queued: 'Queued',
  running: 'Rendering',
  done: 'Ready',
  failed: 'Some lines failed',
  skipped: 'Skipped',
};

function tone(status: SpeechClipStatus): 'good' | 'warning' | 'danger' | 'soft' | 'neutral' {
  if (status.state === 'done' && !status.failed && !status.pending) return 'good';
  if (status.state === 'failed' || status.failed) return 'danger';
  if (status.state === 'disabled' || status.state === 'unavailable') return 'soft';
  return status.state === 'skipped' ? 'warning' : 'neutral';
}

/** Pre-rendered speech for one immutable release: how many fixed lines are ready to play. */
export function SpeechClipStatusPanel({
  agentId,
  releaseId,
  load = loadStatus,
  pollMs = 5_000,
}: {
  agentId: string;
  releaseId: string;
  load?: Load;
  pollMs?: number;
}) {
  const [status, setStatus] = useState<SpeechClipStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      load(agentId, releaseId).then(
        (next) => {
          if (!alive) return;
          setStatus(next);
          setError(undefined);
          if (next.state === 'queued' || next.state === 'running')
            timer = setTimeout(refresh, pollMs);
        },
        (cause: unknown) => {
          if (alive) setError(cause instanceof Error ? cause.message : 'Status is unavailable.');
        },
      );
    void refresh();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, releaseId, load, pollMs]);
  return (
    <Panel labelledBy="speech-clip-status-title">
      <PanelHeader
        id="speech-clip-status-title"
        title="Pre-rendered speech"
        badge={
          status ? <StatusBadge tone={tone(status)}>{LABELS[status.state]}</StatusBadge> : null
        }
      />
      <div className="panel-body stack">
        {error && <div className="notice danger">{error}</div>}
        {!status && !error && <div className="muted">Checking pre-rendered speech…</div>}
        {status && (
          <>
            <p>
              <strong>
                {status.ready} of {status.total}
              </strong>{' '}
              fixed lines ready to play without live synthesis
              {status.failed ? `, ${status.failed} failed` : ''}
              {status.pending && status.state !== 'disabled' ? `, ${status.pending} pending` : ''}.
            </p>
            {status.perCall > 0 && (
              <small className="muted">
                {status.perCall} templated line{status.perCall === 1 ? '' : 's'} with caller
                variables {status.perCall === 1 ? 'is' : 'are'} synthesized per call and never
                stored.
              </small>
            )}
            {status.detail && <small className="muted">{status.detail}</small>}
          </>
        )}
      </div>
    </Panel>
  );
}
