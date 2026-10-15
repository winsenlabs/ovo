'use client';
import { useConfirm } from '../ui/dialog';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, items, type CallSummary, type SessionIdentity } from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { EmptyStateV2, InlineAlert, Skeleton } from '../ui/feedback-v2';
import { CodeBlock } from '../ui/code-block';
import { Select } from '../ui/inputs';
import { RecordingExportPanel } from './recording-export-panel';
import { RecordingSegmentsTable } from './recording-segments-table';
import { RecordingManifestMetadata } from './recording-manifest-metadata';
import type { LiveRecording, Manifest, DetailState } from './live-recording-types';
import { ProductionTrackPlayer } from './production-track-player';

const messageFor = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.status === 503
    ? 'Production recording lifecycle is not configured on this deployment.'
    : error instanceof Error
      ? error.message
      : fallback;

/** The Recording files tab for a live call: manifest metadata, per-track players, the segment
 * table, a redacted export, replay/retention actions — `LiveRecordingsPanel` existed before W14
 * but was mounted nowhere (brief defect #11). */
export function LiveRecordingsPanel({
  call,
  role,
}: {
  call: CallSummary;
  role: SessionIdentity['role'];
}) {
  const confirm = useConfirm();
  const [recordings, setRecordings] = useState<LiveRecording[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<DetailState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string }>();
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
    if (
      !selectedId ||
      !(await confirm(
        'Tombstone recording',
        'Tombstone this recording and schedule physical cleanup?',
      ))
    )
      return;
    setBusy(true);
    try {
      await apiRequest(`${callBase}/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      setMessage({ tone: 'ok', text: 'Recording tombstoned; physical cleanup is asynchronous.' });
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
      setMessage({ tone: 'ok', text: 'Bounded retention sweep completed. Inspect the receipt.' });
      setReplay(data);
      await load();
    } catch (error) {
      setMessage({ tone: 'danger', text: messageFor(error, 'Retention sweep failed.') });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Skeleton shape="block" width="100%" />;
  return (
    <SectionCard
      title="Production recording lifecycle"
      description="Recording evidence is authenticated and segmented. Alignment uses call-event wall clock and does not prove the caller heard a waveform at an exact transcript offset."
      actions={<StatusBadgeV2 tone="warn" label="Carrier media" />}
    >
      <div className="ds-stack">
        {message && (
          <InlineAlert tone={message.tone === 'ok' ? 'info' : 'danger'}>{message.text}</InlineAlert>
        )}
        {recordings.length === 0 ? (
          <EmptyStateV2 variant="unavailable" title="No live recording manifest">
            The recording service returned no carrier artifact. Simulation fixture WAVs are stored
            separately and are never shown as live evidence.
          </EmptyStateV2>
        ) : (
          <>
            <Select
              aria-label="Recording"
              value={selectedId}
              onChange={setSelectedId}
              options={recordings.map((recording) => ({
                value: recording.id,
                label: `${recording.state} · ${recording.id}`,
              }))}
            />
            {detail && (
              <>
                <RecordingManifestMetadata manifest={detail.manifest} />
                <InlineAlert tone="info">
                  The server assembles each captured μ-law track into authenticated PCM WAV for
                  browser playback and seeking. Gaps remain explicit, and seek position is not exact
                  transcript alignment.
                </InlineAlert>
                <div className="ds-stack">
                  {(['inbound', 'outbound'] as const).map((track) => (
                    <ProductionTrackPlayer
                      key={`${selectedId}-${track}`}
                      track={track}
                      recordingState={detail.manifest.state}
                      segments={detail.manifest.segments ?? []}
                      source={`/api/v1${callBase}/${encodeURIComponent(selectedId)}/audio/${track}`}
                    />
                  ))}
                </div>
                <RecordingSegmentsTable
                  segments={detail.manifest.segments ?? []}
                  callBase={callBase}
                  selectedId={selectedId}
                />
                <CodeBlock
                  code={() => JSON.stringify(detail.alignment, null, 2)}
                  collapsedLabel="Alignment and transcript evidence"
                />
                <div className="ui-cluster">
                  <button type="button" className="button" onClick={loadReplay} disabled={busy}>
                    Inspect safe replay contract
                  </button>
                  {role !== 'viewer' && (
                    <button
                      type="button"
                      className="button danger"
                      onClick={tombstone}
                      disabled={busy}
                    >
                      Tombstone recording
                    </button>
                  )}
                  {role === 'admin' && (
                    <button
                      type="button"
                      className="button"
                      onClick={sweepRetention}
                      disabled={busy}
                    >
                      Run bounded retention sweep
                    </button>
                  )}
                </div>
                {replay != null && (
                  <CodeBlock
                    code={() => JSON.stringify(replay, null, 2)}
                    collapsedLabel="Replay or retention receipt"
                  />
                )}
                <RecordingExportPanel call={call} recordingId={selectedId} role={role} />
              </>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
