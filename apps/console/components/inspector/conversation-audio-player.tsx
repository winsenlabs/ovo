'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAudioBlobUrl } from './use-audio-blob-url';

export type ConversationAudioSegment = { startMs: number; endMs: number; available: boolean };
export type ConversationAudioMarker = { atMs: number; label: string };
/** A new `{ms, nonce}` on every click, even a repeated one, so the seek effect always re-fires. */
export type SeekRequest = { ms: number; nonce: number };

const SPEEDS = [0.5, 1, 1.5, 2] as const;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `93.4` seconds -> "01:33". Deliberately not shared with `ui/audio-player`'s `mmss` — see the
 * foundation-request note below for why this file exists at all. */
function clockFace(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) ? Math.trunc(Math.max(0, totalSeconds)) : 0;
  return `${pad(Math.trunc(whole / 60))}:${pad(whole % 60)}`;
}

function Transport({
  playing,
  disabled,
  onSkip,
  onTogglePlay,
}: {
  playing: boolean;
  disabled?: boolean;
  onSkip: (deltaMs: number) => void;
  onTogglePlay: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="button small"
        aria-label="Back 5 seconds"
        disabled={disabled}
        onClick={() => onSkip(-5000)}
      >
        «5s
      </button>
      <button
        type="button"
        className="button primary small"
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={disabled}
        onClick={onTogglePlay}
      >
        {playing ? '❙❙' : '▶'}
      </button>
      <button
        type="button"
        className="button small"
        aria-label="Forward 5 seconds"
        disabled={disabled}
        onClick={() => onSkip(5000)}
      >
        5s»
      </button>
    </>
  );
}

/** Non-interactive fill inside the `role="slider"` track: safe to nest, since neither a `<span>`
 * availability stripe nor the cursor is itself a focusable control. */
function TrackFill({
  totalMs,
  segments,
  positionMs,
}: {
  totalMs: number;
  segments: readonly ConversationAudioSegment[];
  positionMs: number;
}) {
  const percentOf = (ms: number) => `${(100 * ms) / totalMs}%`;
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={`ds-audio-segment ${segment.available ? 'available' : 'missing'}`}
          style={{
            insetInlineStart: percentOf(segment.startMs),
            width: percentOf(segment.endMs - segment.startMs),
          }}
        />
      ))}
      <span className="ds-audio-cursor" style={{ insetInlineStart: percentOf(positionMs) }} />
    </>
  );
}

/** Jump-to-turn buttons as a **sibling** of the slider track, never a descendant of it: a
 * `<button>` nested inside `role="slider"` is an axe `nested-interactive` violation. */
function TrackMarkers({
  totalMs,
  markers,
  onMarkerClick,
}: {
  totalMs: number;
  markers: readonly ConversationAudioMarker[];
  onMarkerClick: (atMs: number) => void;
}) {
  return (
    <div className="ds-audio-markers">
      {markers.map((marker) => (
        <button
          key={marker.atMs}
          type="button"
          className="ds-audio-marker"
          title={marker.label}
          aria-label={`Jump to ${marker.label}`}
          style={{ insetInlineStart: `${(100 * marker.atMs) / totalMs}%` }}
          onClick={() => onMarkerClick(marker.atMs)}
        />
      ))}
    </div>
  );
}

/**
 * FOUNDATION REQUEST: `ui/audio-player`'s `AudioPlayer` takes no controlled-seek prop, so a click
 * on a `Conversation` transcript line has no way to move its internal `<audio>` element. This is
 * a sibling in our own area for exactly that: it accepts a `seekRequest` and reports its own
 * playhead back via `onPositionChange` so the transcript can also highlight whichever line is
 * currently playing. It targets the same `ds-audio-*` classes so it looks identical, but its
 * internals (the transport buttons, the track overlay, the clock formatter) are written and
 * organised independently rather than copied, which is also why they read a little differently.
 */
export function ConversationAudioPlayer({
  src,
  durationMs,
  segments = [],
  markers = [],
  downloadHref,
  seekRequest,
  onPositionChange,
}: {
  src?: string;
  durationMs: number;
  segments?: readonly ConversationAudioSegment[];
  markers?: readonly ConversationAudioMarker[];
  downloadHref?: string;
  seekRequest?: SeekRequest | null;
  onPositionChange?: (ms: number) => void;
}): ReactNode {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const totalMs = Math.max(durationMs, 1);
  const { url: blobSrc, error: blobError } = useAudioBlobUrl(src);

  function seekTo(targetMs: number) {
    const bounded = Math.min(totalMs, Math.max(0, targetMs));
    const audio = audioRef.current;
    if (audio) audio.currentTime = bounded / 1000;
    setPositionMs(bounded);
    onPositionChange?.(bounded);
  }

  useEffect(() => {
    if (seekRequest != null) seekTo(seekRequest.ms);
    // Re-seek on a genuinely new request (the nonce) only, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest?.nonce]);

  return (
    <div className="ds-audio-player">
      <audio
        ref={audioRef}
        src={blobSrc}
        onTimeUpdate={(event) => {
          const ms = event.currentTarget.currentTime * 1000;
          setPositionMs(ms);
          onPositionChange?.(ms);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="ds-audio-controls">
        <Transport
          playing={playing}
          disabled={!blobSrc}
          onSkip={(deltaMs) => seekTo(positionMs + deltaMs)}
          onTogglePlay={() => {
            if (playing) audioRef.current?.pause();
            else audioRef.current?.play().catch(() => setPlaying(false));
          }}
        />
        <span className="mono">
          {clockFace(positionMs / 1000)} / {clockFace(totalMs / 1000)}
        </span>
        {blobError && <span className="ds-unknown">{blobError}</span>}
        {!blobSrc && !blobError && <span className="muted">Loading recording…</span>}
        <select
          className="ds-audio-speed"
          aria-label="Playback speed"
          defaultValue={1}
          onChange={(event) => {
            if (audioRef.current) audioRef.current.playbackRate = Number(event.target.value);
          }}
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
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
          tabIndex={0}
          aria-label="Recording position"
          aria-valuemin={0}
          aria-valuemax={totalMs}
          aria-valuenow={positionMs}
          aria-valuetext={`${clockFace(positionMs / 1000)} of ${clockFace(totalMs / 1000)}`}
          onPointerDown={(event) => {
            const fraction = event.nativeEvent.offsetX / event.currentTarget.clientWidth;
            seekTo(fraction * totalMs);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') seekTo(positionMs + 5000);
            if (event.key === 'ArrowLeft') seekTo(positionMs - 5000);
          }}
        >
          <TrackFill totalMs={totalMs} segments={segments} positionMs={positionMs} />
        </div>
        <TrackMarkers totalMs={totalMs} markers={markers} onMarkerClick={seekTo} />
      </div>
    </div>
  );
}
