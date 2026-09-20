'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  apiRequest,
  items,
  type CallSummary,
  type RecordingMetadata,
  type SessionIdentity,
} from '../../lib/api';
import { EmptyState, Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { LiveRecordingsPanel } from './live-recordings-panel';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; recordings: RecordingMetadata[] }
  | { status: 'error'; message: string };

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The WAV fixture could not be read.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : '';
      if (!base64) reject(new Error('The WAV fixture was empty.'));
      else resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

function RecordingPlayer({ callId, recording }: { callId: string; recording: RecordingMetadata }) {
  const [playbackError, setPlaybackError] = useState<string>();
  const expired = Date.parse(recording.expiresAt) <= Date.now();
  const sourceLabel =
    recording.source === 'fixture' ? 'Simulation fixture' : 'Carrier-labelled archive';
  return (
    <article className="recording-card">
      <div className="recording-heading">
        <div>
          <h3>{sourceLabel}</h3>
          <small className="mono">{recording.id}</small>
        </div>
        <StatusBadge
          tone={expired ? 'danger' : recording.source === 'fixture' ? 'soft' : 'neutral'}
        >
          {expired ? 'Expired' : sourceLabel}
        </StatusBadge>
      </div>
      <dl className="metadata-list">
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(recording.durationMs)}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>
            {recording.format.toUpperCase()} · {recording.sampleRate} Hz · {recording.channels} ch ·{' '}
            {recording.bitsPerSample} bit
          </dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(recording.bytes)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(recording.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{new Date(recording.expiresAt).toLocaleString()}</dd>
        </div>
      </dl>
      {expired ? (
        <Notice tone="warning">
          Retention has expired. Audio is no longer presented as playable.
        </Notice>
      ) : (
        <audio
          controls
          preload="metadata"
          src={`/api/v1/calls/${encodeURIComponent(callId)}/recordings/${encodeURIComponent(recording.id)}/audio`}
          onError={() =>
            setPlaybackError(
              'Audio could not be loaded. It may have expired or the archive may be unavailable.',
            )
          }
          onCanPlay={() => setPlaybackError(undefined)}
        >
          Your browser does not support WAV playback.
        </audio>
      )}
      {playbackError && (
        <Notice tone="danger" live>
          {playbackError}
        </Notice>
      )}
    </article>
  );
}

export function RecordingPanel({
  call,
  role,
}: {
  call?: CallSummary;
  role: SessionIdentity['role'];
}) {
  if (call && call.kind !== 'simulation') return <LiveRecordingsPanel call={call} role={role} />;
  return <FixtureRecordingPanel call={call} role={role} />;
}

function FixtureRecordingPanel({
  call,
  role,
}: {
  call?: CallSummary;
  role: SessionIdentity['role'];
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{
    tone: 'neutral' | 'danger';
    text: string;
  }>();

  const load = useCallback(async () => {
    if (!call) return;
    setState({ status: 'loading' });
    try {
      const { data } = await apiRequest<unknown>(`/calls/${call.id}/recordings`);
      setState({ status: 'ready', recordings: items<RecordingMetadata>(data) });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Recording metadata is unavailable.',
      });
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function uploadFixture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!call || call.kind !== 'simulation') return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const file = values.get('wav');
    if (!(file instanceof File) || !file.size)
      return setUploadMessage({ tone: 'danger', text: 'Choose a WAV fixture.' });
    if (file.size > 150 * 1024)
      return setUploadMessage({
        tone: 'danger',
        text: 'Fixture WAV must be 150 KiB or smaller for the management API request limit.',
      });
    setUploading(true);
    setUploadMessage(undefined);
    try {
      const wavBase64 = await fileAsBase64(file);
      await apiRequest(`/calls/${call.id}/recordings`, {
        method: 'POST',
        body: JSON.stringify({ wavBase64, retentionDays: Number(values.get('retentionDays')) }),
      });
      form.reset();
      setUploadMessage({
        tone: 'neutral',
        text: 'Simulation fixture archived. The backend records its source as fixture.',
      });
      await load();
    } catch (error) {
      setUploadMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'Fixture upload failed.',
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Panel labelledBy="recordings-title">
      <PanelHeader
        id="recordings-title"
        title="Call recording"
        badge={
          <StatusBadge tone={call?.kind === 'simulation' ? 'soft' : 'neutral'}>
            {call?.kind === 'simulation' ? 'Simulation evidence' : 'Archived evidence'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <Notice tone="warning">
          Audio metadata and playback are archive evidence only. The console does not infer
          transcript alignment, speaker timing, carrier authorization, or production capture.
        </Notice>
        {state.status === 'loading' && (
          <p className="muted" role="status">
            Loading recording metadata…
          </p>
        )}
        {state.status === 'error' && (
          <Notice tone="danger" live>
            {state.message}{' '}
            <button className="text-button" onClick={load}>
              Retry
            </button>
          </Notice>
        )}
        {state.status === 'ready' && state.recordings.length === 0 && (
          <EmptyState title="No recording archived">
            No audio metadata was returned for this call. Missing audio is not treated as a
            completed recording.
          </EmptyState>
        )}
        {state.status === 'ready' &&
          state.recordings.map((recording) => (
            <RecordingPlayer key={recording.id} callId={call?.id ?? ''} recording={recording} />
          ))}
        {call?.kind === 'simulation' && (
          <form className="fixture-upload" onSubmit={uploadFixture}>
            <div>
              <h3>Optional simulation fixture</h3>
              <p className="muted">
                Upload a small WAV only to exercise authenticated archive and playback behavior.
                This is not a real call recording.
              </p>
            </div>
            <div className="form-grid">
              <Field label="Fixture WAV" htmlFor="recording-wav">
                <input id="recording-wav" name="wav" type="file" accept="audio/wav,.wav" required />
              </Field>
              <Field label="Retention" htmlFor="recording-retention">
                <select id="recording-retention" name="retentionDays" defaultValue="7">
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
              </Field>
            </div>
            <button className="button align-start" disabled={uploading || role === 'viewer'}>
              {uploading ? 'Archiving fixture…' : 'Archive simulation fixture'}
            </button>
            {role === 'viewer' && <small>Editor access is required to upload a fixture.</small>}
          </form>
        )}
        {uploadMessage && (
          <Notice tone={uploadMessage.tone} live>
            {uploadMessage.text}
          </Notice>
        )}
      </div>
    </Panel>
  );
}
