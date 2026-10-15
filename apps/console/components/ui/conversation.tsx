'use client';
import { useState } from 'react';

export type ConversationLine = {
  id: string;
  speaker: 'agent' | 'caller' | 'operator';
  /** Absent for lines with no clock (the turns handed over before a human joined). */
  atMs?: number;
  text: string;
  interim?: boolean;
  played?: boolean;
  latencyMs?: number;
  routeTier?: string;
};

const SPEAKER_LABEL = { agent: 'Agent', caller: 'Caller', operator: 'You' } as const;

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Chat-style transcript: agent left (accent-soft), caller right (surface-2). Interim lines are
 * faint and collapsible; a line with no audio ("generated not played") is dashed. Clicking a
 * final line seeks the paired `AudioPlayer` via `onSeek`.
 */
export function Conversation({
  lines,
  activeId,
  onSeek,
  liveInterim = false,
}: {
  lines: readonly ConversationLine[];
  activeId?: string;
  onSeek?: (atMs: number) => void;
  /** Live captions: show interim lines in place (faint, italic) instead of behind a toggle. */
  liveInterim?: boolean;
}) {
  const [showInterim, setShowInterim] = useState(false);
  const visible = showInterim || liveInterim ? lines : lines.filter((line) => !line.interim);
  const interimCount = liveInterim ? 0 : lines.length - lines.filter((line) => !line.interim).length;

  return (
    <div className="ds-conversation">
      {interimCount > 0 && (
        <button type="button" className="text-button" onClick={() => setShowInterim((v) => !v)}>
          {showInterim ? 'Hide interim lines' : `Show ${interimCount} interim lines`}
        </button>
      )}
      <ol className="ds-conversation-list">
        {visible.map((line) => (
          <li
            key={line.id}
            className={`speaker-${line.speaker} ${line.interim ? 'interim' : ''} ${
              line.played === false ? 'unplayed' : ''
            } ${activeId === line.id ? 'active' : ''}`}
          >
            <button
              type="button"
              className="ds-conversation-bubble"
              onClick={() => line.atMs !== undefined && onSeek?.(line.atMs)}
              disabled={!onSeek || line.interim || line.atMs === undefined}
            >
              <span className="ds-conversation-meta">
                {/* Position + colour alone conveyed the speaker before; name it too (brief §1
                    rule 3 — never colour-only meaning). */}
                <span className="ds-conversation-speaker">
                  {SPEAKER_LABEL[line.speaker]}
                </span>
                {line.atMs !== undefined && <span className="mono">{mmss(line.atMs)}</span>}
                {line.played === false && <span className="ds-chip">Generated, not played</span>}
                {line.latencyMs != null && (
                  <span className="ds-chip">first audio {line.latencyMs} ms</span>
                )}
                {line.routeTier && <span className="ds-chip">{line.routeTier}</span>}
              </span>
              <span>{line.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
