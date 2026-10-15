'use client';
import { useState } from 'react';

export type ConversationLine = {
  id: string;
  speaker: 'agent' | 'caller';
  atMs: number;
  text: string;
  interim?: boolean;
  played?: boolean;
  latencyMs?: number;
  routeTier?: string;
};

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
}: {
  lines: readonly ConversationLine[];
  activeId?: string;
  onSeek?: (atMs: number) => void;
}) {
  const [showInterim, setShowInterim] = useState(false);
  const visible = showInterim ? lines : lines.filter((line) => !line.interim);
  const interimCount = lines.length - lines.filter((line) => !line.interim).length;

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
              onClick={() => onSeek?.(line.atMs)}
              disabled={!onSeek || line.interim}
            >
              <span className="ds-conversation-meta">
                {/* Position + colour alone conveyed the speaker before; name it too (brief §1
                    rule 3 — never colour-only meaning). */}
                <span className="ds-conversation-speaker">
                  {line.speaker === 'agent' ? 'Agent' : 'Caller'}
                </span>
                <span className="mono">{mmss(line.atMs)}</span>
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
