'use client';
import { useRef, useState } from 'react';

export type AudioSegment = { startMs: number; endMs: number; available: boolean };
export type AudioMarker = { atMs: number; label: string };

const SPEEDS = [0.5, 1, 1.5, 2] as const;

function mmss(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Segment-availability bar (available/missing stretches), play/pause, ±5s, speed, "jump to turn"
 * markers and a download link. `durationMs` seeds the bar before metadata loads.
 */
export function AudioPlayer({
  src,
  durationMs,
  segments = [],
  markers = [],
  downloadHref,
  onSeek,
}: {
  src: string;
  durationMs: number;
  segments?: readonly AudioSegment[];
  markers?: readonly AudioMarker[];
  downloadHref?: string;
  onSeek?: (atMs: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const total = Math.max(durationMs, 1);

  const seekTo = (atMs: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = atMs / 1000;
    setCurrentMs(atMs);
    onSeek?.(atMs);
  };

  return (
    <div className="ds-audio-player">
      <audio
        ref={audioRef}
        src={src || undefined}
        onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="ds-audio-controls">
        <button
          type="button"
          className="button small"
          onClick={() => seekTo(Math.max(0, currentMs - 5000))}
          aria-label="Back 5 seconds"
        >
          «5s
        </button>
        <button
          type="button"
          className="button primary small"
          onClick={() => {
            if (playing) {
              audioRef.current?.pause();
              return;
            }
            // `.play()` returns a promise that rejects when the browser blocks autoplay or the
            // source errors; an unhandled rejection surfaces as a console error (axe/console
            // sweeps flag it) for a problem the operator cannot otherwise see.
            audioRef.current?.play().catch(() => setPlaying(false));
          }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❙❙' : '▶'}
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => seekTo(Math.min(total, currentMs + 5000))}
          aria-label="Forward 5 seconds"
        >
          5s»
        </button>
        <span className="mono">
          {mmss(currentMs / 1000)} / {mmss(total / 1000)}
        </span>
        <select
          className="ds-audio-speed"
          aria-label="Playback speed"
          value={speed}
          onChange={(event) => {
            const next = Number(event.target.value);
            setSpeed(next);
            if (audioRef.current) audioRef.current.playbackRate = next;
          }}
        >
          {SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
        {downloadHref && (
          <a className="text-button" href={downloadHref} download>
            Download
          </a>
        )}
      </div>
      <div className="ds-audio-track-wrap">
        <div
          className="ds-audio-track"
          role="slider"
          aria-label="Recording position"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={currentMs}
          aria-valuetext={`${mmss(currentMs / 1000)} of ${mmss(total / 1000)}`}
          tabIndex={0}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            seekTo(((event.clientX - rect.left) / rect.width) * total);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') seekTo(Math.min(total, currentMs + 5000));
            if (event.key === 'ArrowLeft') seekTo(Math.max(0, currentMs - 5000));
          }}
        >
          {segments.map((segment, index) => (
            <span
              key={index}
              className={`ds-audio-segment ${segment.available ? 'available' : 'missing'}`}
              style={{
                insetInlineStart: `${(segment.startMs / total) * 100}%`,
                width: `${((segment.endMs - segment.startMs) / total) * 100}%`,
              }}
            />
          ))}
          <span
            className="ds-audio-cursor"
            style={{ insetInlineStart: `${(currentMs / total) * 100}%` }}
          />
        </div>
        {/* Markers are a sibling overlay, not a descendant of the `role="slider"` track: a
            button nested inside another interactive widget is an axe `nested-interactive`
            violation. The wrapper itself takes no pointer events so clicks still reach the
            slider everywhere except exactly on a marker. */}
        <div className="ds-audio-markers" aria-hidden="false">
          {markers.map((marker) => (
            <button
              key={marker.atMs}
              type="button"
              className="ds-audio-marker"
              title={marker.label}
              aria-label={`Jump to ${marker.label}`}
              style={{ insetInlineStart: `${(marker.atMs / total) * 100}%` }}
              onClick={() => seekTo(marker.atMs)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
