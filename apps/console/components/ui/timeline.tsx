'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { JsonViewer } from './code-block';
import { humaniseEnum } from '../../lib/status';

export type TimelineEvent = {
  id: string;
  type: string;
  atMs: number;
  /** Required for `groupBy="turn"`; falls back to one ungrouped bucket when it is missing. */
  turnId?: string | number;
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

type Group = { key: string; heading: string; events: readonly TimelineEvent[] };

function groupEvents(events: readonly TimelineEvent[], groupBy: 'minute' | 'turn'): Group[] {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const bucket =
      groupBy === 'turn'
        ? event.turnId != null
          ? `turn:${event.turnId}`
          : 'ungrouped'
        : `minute:${Math.floor(event.atMs / 60000)}`;
    (groups.get(bucket) ?? groups.set(bucket, []).get(bucket)!).push(event);
  }
  return [...groups.entries()].map(([key, groupedEvents]) => {
    const [first] = groupedEvents;
    const heading =
      key === 'ungrouped'
        ? 'Ungrouped'
        : groupBy === 'turn'
          ? `Turn ${first.turnId}`
          : `Minute ${Math.floor(first.atMs / 60000)} (${offset(Math.floor(first.atMs / 60000) * 60000)})`;
    return { key, heading, events: groupedEvents };
  });
}

/**
 * Vertical event list grouped by minute or turn (real `<h3>` group headings, not just a label
 * saying so), filterable by a humanised type, each row expandable to its raw payload. Changing
 * the filter resets paging back to the first page.
 */
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
  useEffect(() => setVisible(pageSize), [typeFilter, pageSize]);
  const types = useMemo(() => [...new Set(events.map((e) => e.type))], [events]);
  const filtered = typeFilter === 'all' ? events : events.filter((e) => e.type === typeFilter);
  const page = filtered.slice(0, visible);
  const remaining = filtered.length - page.length;
  const groups = useMemo(() => groupEvents(page, groupBy), [page, groupBy]);

  return (
    <div className="ds-timeline-wrap">
      <div className="ds-toolbar">
        <label className="ds-timeline-filter">
          Filter by type
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="all">All types ({events.length})</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {humaniseEnum(type)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted" data-testid="timeline-grouping">
          Grouped by {groupBy}
        </span>
      </div>
      {groups.map((group) => (
        <section key={group.key} className="ds-timeline-group">
          <h3 className="ds-timeline-group-heading">{group.heading}</h3>
          <ol className="ds-timeline">
            {group.events.map((event) => (
              <li key={event.id} className={`tone-${event.tone ?? 'neutral'}`}>
                <span className="ds-timeline-dot" aria-hidden="true">
                  {event.icon}
                </span>
                <div className="ds-timeline-row">
                  <span className="mono ds-timeline-offset">{offset(event.atMs)}</span>
                  <span className="ds-timeline-type">{humaniseEnum(event.type)}</span>
                  <span className="ds-timeline-summary">{event.summary}</span>
                  {event.payload != null && <JsonViewer value={event.payload} label="Payload" />}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
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
