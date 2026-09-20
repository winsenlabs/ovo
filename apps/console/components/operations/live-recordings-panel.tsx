'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, items, type CallSummary, type SessionIdentity } from '../../lib/api';
import {
  EmptyState,
  JsonEvidence,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { RecordingExportPanel } from './recording-export-panel';
import { ProductionTrackPlayer, type RecordingTrackSegment } from './production-track-player';

type LiveRecording = {
  id: string;
  state:
    | 'starting'
    | 'active'
    | 'paused'
    | 'finalizing'
    | 'available'
    | 'partial'
    | 'failed'
    | 'expired';
  source: 'carrier';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  codec: 'audio/x-mulaw';
  sampleRate: 8000;
  channels: 2;
  segmentBytes: number;
};
type Segment = RecordingTrackSegment & {
  timestampEvidence?: string;
  sha256?: string;
};
type Manifest = LiveRecording & { segments: Segment[]; timeline?: unknown };
type DetailState = { manifest: Manifest; alignment: unknown };

const messageFor = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.status === 503
    ? 'Production recording lifecycle is not configured on this deployment.'
    : error instanceof Error
      ? error.message
      : fallback;

export function LiveRecordingsPanel({
  call,
  role,
}: {
  call: CallSummary;
  role: SessionIdentity['role'];
}) {
  const [recordings, setRecordings] = useState<LiveRecording[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<DetailState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'neutral' | 'danger'; text: string }>();
  const [replay, setReplay] = useState<unknown>();
  const callBase = `/calls/${encodeURIComponent(call.id)}/live-recordings`;

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(undefined);
    try {
      const { data } = await apiRequest<unknown>(callBase);
      const next = items<LiveRecording>(data);
      setRecordings(next);
      setSelectedId((current) =>
        current && next.some((recording) => recording.id === current) ? current : next[0]?.id || '',
      );
    } catch (error) {
      setRecordings([]);
      setMessage({ tone: 'danger', text: messageFor(error, 'Recordings could not be loaded.') });
    } finally {
      setLoading(false);
    }
  }, [callBase]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    const base = `${callBase}/${encodeURIComponent(selectedId)}`;
    Promise.all([
      apiRequest<Manifest>(`${base}/manifest`),
      apiRequest<unknown>(`${base}/alignment`),
    ])
      .then(([manifest, alignment]) =>
        setDetail({ manifest: manifest.data, alignment: alignment.data }),
      )
      .catch((error) => {
        setDetail(undefined);
        setMessage({
          tone: 'danger',
          text: messageFor(error, 'Recording evidence could not be loaded.'),
        });
      });
  }, [callBase, selectedId]);

  async function tombstone() {
    if (!selectedId || !window.confirm('Tombstone this recording and schedule physical cleanup?'))
      return;
    setBusy(true);
    try {
      await apiRequest(`${callBase}/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      setMessage({
        tone: 'neutral',
        text: 'Recording tombstoned; physical cleanup is asynchronous.',
      });
      await load();
    } catch (error) {
      setMessage({ tone: 'danger', text: messageFor(error, 'Recording could not be tombstoned.') });
    } finally {
      setBusy(false);
    }
  }

  async function loadReplay() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const { data } = await apiRequest(`${callBase}/${encodeURIComponent(selectedId)}/replay`);
      setReplay(data);
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: messageFor(error, 'Replay evidence could not be loaded.'),
      });
    } finally {
      setBusy(false);
    }
  }

  async function sweepRetention() {
    setBusy(true);
    try {
      const { data } = await apiRequest('/recordings/retention/sweep', {
        method: 'POST',
        body: JSON.stringify({ limit: 100 }),
      });
      setMessage({
        tone: 'neutral',
        text: 'Bounded retention sweep completed. Inspect the receipt.',
      });
      setReplay(data);
      await load();
    } catch (error) {
      setMessage({ tone: 'danger', text: messageFor(error, 'Retention sweep failed.') });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingBlock label="Loading production recording manifests" />;
  return (
    <Panel labelledBy="live-recordings-title">
      <PanelHeader
        id="live-recordings-title"
        title="Production recording lifecycle"
        badge={<StatusBadge tone="warning">Carrier media</StatusBadge>}
      />
      <div className="panel-body stack">
        <Notice tone="warning">
          Recording evidence is authenticated and segmented. Alignment uses call-event wall clock
          and does not prove the caller heard a waveform at an exact transcript offset.
        </Notice>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        {recordings.length === 0 ? (
          <EmptyState title="No live recording manifest">
            The recording service returned no carrier artifact. Simulation fixture WAVs are stored
            separately and are never shown as live evidence.
          </EmptyState>
        ) : (
          <>
            <label className="field">
              <span>Recording</span>
              <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                {recordings.map((recording) => (
                  <option key={recording.id} value={recording.id}>
                    {recording.state} · {recording.id}
                  </option>
                ))}
              </select>
            </label>
            {detail && (
              <>
                <dl className="metadata-list">
                  <div>
                    <dt>State</dt>
                    <dd>{detail.manifest.state}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>8 kHz μ-law · two captured tracks</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{new Date(detail.manifest.createdAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{new Date(detail.manifest.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="stack">
                  <Notice tone="neutral">
                    The server assembles each captured μ-law track into authenticated PCM WAV for
                    browser playback and seeking. Gaps remain explicit, and seek position is not
                    exact transcript alignment.
                  </Notice>
                  {(['inbound', 'outbound'] as const).map((track) => (
                    <ProductionTrackPlayer
                      key={`${selectedId}-${track}`}
                      track={track}
                      recordingState={detail.manifest.state}
                      segments={detail.manifest.segments}
                      source={`/api/v1${callBase}/${encodeURIComponent(selectedId)}/audio/${track}`}
                    />
                  ))}
                </div>
                <ResponsiveTable label="Recording segments">
                  <thead>
                    <tr>
                      <th>Track</th>
                      <th>Sequence</th>
                      <th>State</th>
                      <th>Window</th>
                      <th>Bytes</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.manifest.segments.map((segment) => (
                      <tr key={`${segment.track}-${segment.sequence}`}>
                        <td>{segment.track}</td>
                        <td>{segment.sequence}</td>
                        <td>{segment.state}</td>
                        <td>
                          {segment.startMs}–{segment.endMs} ms
                        </td>
                        <td>{segment.bytes.toLocaleString()}</td>
                        <td>
                          {segment.state === 'available' ? (
                            <a
                              className="text-button"
                              href={`/api/v1${callBase}/${encodeURIComponent(selectedId)}/segments/${encodeURIComponent(segment.track)}/${segment.sequence}/audio`}
                              download
                            >
                              Download source μ-law segment
                            </a>
                          ) : (
                            (segment.timestampEvidence ?? 'Unavailable')
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </ResponsiveTable>
                <JsonEvidence label="Alignment and transcript evidence" value={detail.alignment} />
                <div className="button-row">
                  <button className="button" type="button" onClick={loadReplay} disabled={busy}>
                    Inspect safe replay contract
                  </button>
                  {role !== 'viewer' && (
                    <button
                      className="button danger"
                      type="button"
                      onClick={tombstone}
                      disabled={busy}
                    >
                      Tombstone recording
                    </button>
                  )}
                  {role === 'admin' && (
                    <button
                      className="button"
                      type="button"
                      onClick={sweepRetention}
                      disabled={busy}
                    >
                      Run bounded retention sweep
                    </button>
                  )}
                </div>
                {replay && <JsonEvidence label="Replay or retention receipt" value={replay} />}
                <RecordingExportPanel call={call} recordingId={selectedId} role={role} />
              </>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
