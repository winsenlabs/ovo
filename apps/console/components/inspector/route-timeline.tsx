'use client';
import { ChartFrame, type ChartTableColumn } from '../charts/chart-frame';
import { XAxis } from '../charts/axis';
import { formatMsAxis, linearScale } from '../charts/scale';
import { formatDuration } from '../../lib/format';
import { humaniseEnum } from '../../lib/status';
import type { RouteTimeline, TimelineSegment } from '../../lib/derive/call-route';
import type { SegmentRole } from '../../lib/types/call-route';

const ROLE_FILL: Record<SegmentRole, string> = {
  router: 'var(--chart-8)',
  agent: 'var(--chart-2)',
  human: 'var(--chart-3)',
};
const ROLE_LABEL: Record<SegmentRole, string> = {
  router: 'Router',
  agent: 'Agent',
  human: 'Person',
};
type Lane = 'pins' | 'hold' | SegmentRole;
const LANE_HEIGHT = 36;
const BAR_HEIGHT = 14;
const MARGIN = { top: 8, right: 16, bottom: 28, left: 72 };
const MIN_LABEL_WIDTH = 22;

interface Row {
  kind: 'Segment' | 'Hold' | 'Disclosure';
  what: string;
  fromMs: number;
  toMs: number | null;
  detail: string;
}

/** Every mark of the chart as a table row, in time order: the chart's accessible alternative. */
export function timelineRows(timeline: RouteTimeline): Row[] {
  const rows: Row[] = [
    ...timeline.segments.map((segment) => ({
      kind: 'Segment' as const,
      what: `#${segment.index} ${segment.label}`,
      fromMs: segment.startMs,
      toMs: segment.endMs,
      detail: `${ROLE_LABEL[segment.role]}${segment.open ? ', end inferred' : ''}`,
    })),
    ...timeline.gaps.map((gap) => ({
      kind: 'Hold' as const,
      what: `Transfer ${gap.transfer}`,
      fromMs: gap.startMs,
      toMs: gap.endMs,
      detail: `Caller held ${formatDuration(gap.holdMs)}${gap.outcome ? `, ${humaniseEnum(gap.outcome)}` : ''}`,
    })),
    ...timeline.pins.map((pin) => ({
      kind: 'Disclosure' as const,
      what: pin.kinds.map(humaniseEnum).join(', '),
      fromMs: pin.atMs,
      toMs: null,
      detail: pin.segment == null ? 'Played to the caller' : `Played in segment ${pin.segment}`,
    })),
  ];
  return rows.sort((a, b) => a.fromMs - b.fromMs);
}

const TABLE_COLUMNS = (rows: readonly Row[]): ChartTableColumn[] => [
  { header: 'Mark', cell: (i) => rows[i]!.kind },
  { header: 'What', cell: (i) => rows[i]!.what },
  { header: 'From', cell: (i) => formatDuration(rows[i]!.fromMs) },
  { header: 'To', cell: (i) => (rows[i]!.toMs == null ? '' : formatDuration(rows[i]!.toMs)) },
  { header: 'Detail', cell: (i) => rows[i]!.detail },
];

function Bar({ segment, x }: { segment: TimelineSegment; x: (ms: number) => number }) {
  const left = x(segment.startMs);
  const width = Math.max(2, x(segment.endMs) - left);
  return (
    <>
      <rect
        x={left}
        y={LANE_HEIGHT - BAR_HEIGHT - 6}
        width={width}
        height={BAR_HEIGHT}
        rx={3}
        fill={ROLE_FILL[segment.role]}
        opacity={segment.open ? 0.55 : 1}
        role="img"
        aria-label={`Segment ${segment.index}, ${segment.label}, ${formatDuration(segment.startMs)} to ${formatDuration(segment.endMs)}`}
      />
      {width >= MIN_LABEL_WIDTH && (
        <text
          x={left}
          y={LANE_HEIGHT - BAR_HEIGHT - 10}
          className="ds-chart-row-label"
          aria-hidden="true"
        >
          #{segment.index}
        </text>
      )}
    </>
  );
}

function TimelineSvg({ timeline, width }: { timeline: RouteTimeline; width: number }) {
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const x = linearScale([0, timeline.totalMs], [0, plotWidth]);
  const rows: Lane[] = [
    ...(timeline.pins.length ? (['pins'] as const) : []),
    ...timeline.lanes,
    ...(timeline.gaps.length ? (['hold'] as const) : []),
  ];
  const height = MARGIN.top + rows.length * LANE_HEIGHT + MARGIN.bottom;
  const rowTop = (key: Lane) => rows.indexOf(key) * LANE_HEIGHT;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Segment timeline"
    >
      <defs>
        <pattern
          id="route-hatch-hold"
          width={6}
          height={6}
          patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse"
        >
          <rect width={6} height={6} fill="var(--surface-2)" />
          <line x1={0} y1={0} x2={0} y2={6} stroke="var(--text-3)" strokeWidth={2} />
        </pattern>
      </defs>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        <XAxis
          domain={[0, timeline.totalMs]}
          scale={x}
          y={rows.length * LANE_HEIGHT}
          format={formatMsAxis}
          width={plotWidth}
        />
        {rows.map((key, index) => (
          <g key={key} transform={`translate(0,${index * LANE_HEIGHT})`}>
            <line
              x1={0}
              x2={plotWidth}
              y1={LANE_HEIGHT}
              y2={LANE_HEIGHT}
              className="ds-chart-gridline"
            />
            <text x={-8} y={LANE_HEIGHT - 10} textAnchor="end" className="ds-chart-row-label">
              {key === 'pins' ? 'Disclosure' : key === 'hold' ? 'Hold' : ROLE_LABEL[key]}
            </text>
          </g>
        ))}
        {timeline.segments.map((segment) => (
          <g key={segment.index} transform={`translate(0,${rowTop(segment.role)})`}>
            <Bar segment={segment} x={x} />
          </g>
        ))}
        {timeline.gaps.map((gap) => (
          <rect
            key={gap.transfer}
            x={x(gap.startMs)}
            y={rowTop('hold') + LANE_HEIGHT - BAR_HEIGHT - 6}
            width={Math.max(2, x(gap.endMs) - x(gap.startMs))}
            height={BAR_HEIGHT}
            rx={3}
            fill="url(#route-hatch-hold)"
            stroke="var(--text-3)"
            role="img"
            aria-label={`Transfer ${gap.transfer}: caller held ${formatDuration(gap.holdMs)}`}
          />
        ))}
        {timeline.pins.map((pin, index) => (
          <path
            key={index}
            transform={`translate(${x(pin.atMs)},${rowTop('pins') + LANE_HEIGHT - 12})`}
            d="M0,-6 L6,0 L0,6 L-6,0 Z"
            fill="var(--surface)"
            stroke="var(--accent)"
            strokeWidth={2}
            role="img"
            aria-label={`Disclosure played at ${formatDuration(pin.atMs)}: ${pin.kinds.map(humaniseEnum).join(', ')}`}
          />
        ))}
      </g>
    </svg>
  );
}

const HOLD_SWATCH =
  'repeating-linear-gradient(45deg, var(--surface-2) 0 3px, var(--text-3) 3px 5px)';

/**
 * Router, agent and person segments on one time axis (lanes by role). Transfer holds are hatched,
 * disclosures are pinned where they played. The table view lists every mark in time order.
 */
export function SegmentTimeline({ timeline }: { timeline: RouteTimeline }) {
  const rows = timelineRows(timeline);
  return (
    <ChartFrame
      title="Segment timeline"
      ariaLabel="Router, agent and person segments on a shared time axis"
      height={MARGIN.top + MARGIN.bottom + (timeline.lanes.length + 1) * LANE_HEIGHT}
      empty={timeline.segments.length === 0}
      emptyLabel="No segments recorded"
      tableRows={rows.length}
      tableColumns={TABLE_COLUMNS(rows)}
      legend={
        <ul className="ds-chart-legend">
          {timeline.lanes.map((role) => (
            <li key={role}>
              <span className="ds-legend-swatch" style={{ background: ROLE_FILL[role] }} />
              {ROLE_LABEL[role]}
            </li>
          ))}
          {timeline.gaps.length > 0 && (
            <li>
              <span className="ds-legend-swatch" style={{ background: HOLD_SWATCH }} />
              Hold
            </li>
          )}
          {timeline.pins.length > 0 && <li>◇ Disclosure</li>}
        </ul>
      }
      renderChart={(width) => <TimelineSvg timeline={timeline} width={width} />}
    />
  );
}
