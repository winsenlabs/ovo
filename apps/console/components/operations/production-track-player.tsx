'use client';
import { useMemo, useRef, useState } from 'react';
import { Notice, StatusBadge } from '../primitives';

export interface RecordingTrackSegment {
  track: string;
  sequence: number;
  state: string;
  bytes: number;
  startMs: number;
  endMs: number;
}

export interface TrackEvidence {
  available: number;
  total: number;
  partial: boolean;
  gapCount: number;
  gapSequences: number[];
}

export function recordingTrackEvidence(
  recordingState: string,
  segments: RecordingTrackSegment[],
  track: string,
): TrackEvidence {
  const selected = segments
    .filter((segment) => segment.track === track)
    .sort((left, right) => left.sequence - right.sequence);
  const gapSequences: number[] = [];
  let gapCount = 0;
  let expectedSequence = 0;
  for (const segment of selected) {
    const missing = Math.max(0, segment.sequence - expectedSequence);
    gapCount += missing;
    for (
      let sequence = expectedSequence;
      sequence < segment.sequence && gapSequences.length < 20;
      sequence += 1
    ) {
      gapSequences.push(sequence);
    }
    if (segment.state !== 'available') {
      gapCount += 1;
      if (gapSequences.length < 20) gapSequences.push(segment.sequence);
    }
    expectedSequence = segment.sequence + 1;
  }
  return {
    available: selected.filter((segment) => segment.state === 'available').length,
    total: selected.length,
    partial: recordingState === 'partial' || selected.length === 0 || gapCount > 0,
    gapCount,
    gapSequences,
  };
}

const time = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '0:00';
  const bounded = Math.max(0, seconds);
  return `${Math.floor(bounded / 60)}:${String(Math.floor(bounded % 60)).padStart(2, '0')}`;
};

export function ProductionTrackPlayer({
  source,
  track,
  recordingState,
  segments,
}: {
  source: string;
  track: 'inbound' | 'outbound';
  recordingState: string;
  segments: RecordingTrackSegment[];
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string>();
  const evidence = useMemo(
    () => recordingTrackEvidence(recordingState, segments, track),
    [recordingState, segments, track],
  );
  const label = track === 'inbound' ? 'Inbound caller track' : 'Outbound agent track';
  return (
    <article className="recording-card">
      <div className="recording-heading">
        <div>
          <h3>{label}</h3>
          <small>
            {evidence.available} of {evidence.total} captured segments available
          </small>
        </div>
        <StatusBadge tone={evidence.partial ? 'warning' : 'good'}>
          {evidence.partial ? 'Partial / gaps' : 'Available'}
        </StatusBadge>
      </div>
      {evidence.available ? (
        <>
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={source}
            onLoadedMetadata={(event) => {
              setDuration(
                Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0,
              );
              setError(undefined);
            }}
            onDurationChange={(event) =>
              setDuration(
                Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0,
              )
            }
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onError={() =>
              setError(
                'This authenticated WAV track could not be loaded. It may be incomplete, expired, or unavailable.',
              )
            }
          >
            Your browser does not support WAV playback.
          </audio>
          <label className="field">
            <span>
              Seek within assembled track · {time(position)} / {time(duration)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(position, duration || 0)}
              disabled={!duration}
              aria-label={`Seek ${label}`}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (audio.current) audio.current.currentTime = next;
                setPosition(next);
              }}
            />
          </label>
        </>
      ) : (
        <Notice tone="warning">No available segments can be assembled for this track.</Notice>
      )}
      {evidence.partial && evidence.total > 0 && (
        <Notice tone="warning">
          Playback is partial evidence.
          {evidence.gapCount
            ? ` Missing or unavailable segment sequences${evidence.gapCount > evidence.gapSequences.length ? ' (first 20)' : ''}: ${evidence.gapSequences.join(', ')}.`
            : ' The recording manifest is marked partial.'}
        </Notice>
      )}
      {error && (
        <Notice tone="danger" live>
          {error}
        </Notice>
      )}
    </article>
  );
}
