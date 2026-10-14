'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { JsonViewer } from './code-block';

export type TimelineEvent = {
  id: string;
  type: string;
  atMs: number;
  icon?: ReactNode;
  tone?: 'ok' | 'info' | 'warn' | 'danger' | 'neutral';
  summary: ReactNode;
  payload?: unknown;
};

function offset(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const seconds = Math.floor(abs / 1000);
  const tenths = Math.floor((abs % 1000) / 100);
  return `${sign}${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${tenths}`;
}

/** Vertical event list grouped by minute, filterable by type, each row expandable to its payload. */
export function Timeline({
  events,
  groupBy = 'minute',
  pageSize = 40,
}: {
  events: readonly TimelineEvent[];
  groupBy?: 'minute' | 'turn';
  pageSize?: number;
}) {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [visible, setVisible] = useState(pageSize);
  const types = useMemo(() => [...new Set(events.map((e) => e.type))], [events]);
  const filtered = typeFilter === 'all' ? events : events.filter((e) => e.type === typeFilter);
  const page = filtered.slice(0, visible);
  const remaining = filtered.length - page.length;

  return (
    <div className="ds-timeline-wrap">
      <div className="ds-toolbar">
        <label className="ds-timeline-filter">
          Filter by type
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="all">All types ({events.length})</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <span className="muted" data-testid="timeline-grouping">
          Grouped by {groupBy}
        </span>
      </div>
      <ol className="ds-timeline">
        {page.map((event) => (
          <li key={event.id} className={`tone-${event.tone ?? 'neutral'}`}>
            <span className="ds-timeline-dot" aria-hidden="true">
              {event.icon}
            </span>
            <div className="ds-timeline-row">
              <span className="mono ds-timeline-offset">{offset(event.atMs)}</span>
              <span className="ds-timeline-type">{event.type}</span>
              <span className="ds-timeline-summary">{event.summary}</span>
              {event.payload != null && <JsonViewer value={event.payload} label="Payload" />}
            </div>
          </li>
        ))}
      </ol>
      {remaining > 0 && (
        <button
          type="button"
          className="text-button"
          onClick={() => setVisible((n) => n + pageSize)}
        >
          {remaining} more
        </button>
      )}
    </div>
  );
}
