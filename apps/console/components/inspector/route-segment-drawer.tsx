'use client';
import { useMemo } from 'react';
import { WideDrawer } from './route-wide-drawer';
import { Conversation, type ConversationLine } from '../ui/conversation';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { KeyValueGrid, SectionCard } from '../ui/section-card';
import { Duration, Money } from '../ui/display';
import { Timeline, type TimelineEvent } from '../ui/timeline';
import { REASON_LABELS, paise, type TimelineSegment } from '../../lib/derive/call-route';
import { humaniseEnum } from '../../lib/status';
import { shortenId } from '../../lib/format';
import type { RouteEvent, SegmentCost } from '../../lib/types/call-route';

function costRows(cost: SegmentCost | null) {
  if (!cost) return [{ label: 'Cost', value: null }];
  return [
    ['Estimated', cost.estimatedPaise],
    ['Reconciled', cost.reconciledPaise],
    ['Total', cost.totalPaise],
  ].map(([label, value]) => ({
    label: label!,
    value: <Money minorUnits={paise(value)} currency={cost.currency} />,
  }));
}

/**
 * One segment in detail: when it ran and how it ended, what it cost, what was said in it and the
 * routing events that moved the call into and out of it. Opened from the segments table or a
 * `?segment=` link.
 */
export function SegmentDrawer({
  segment,
  cost,
  events,
  lines,
  callStartMs,
  onClose,
}: {
  segment: TimelineSegment | null;
  cost: SegmentCost | null;
  events: readonly RouteEvent[];
  lines: readonly ConversationLine[];
  callStartMs: number | null;
  onClose: () => void;
}) {
  const timeline = useMemo<TimelineEvent[]>(
    () =>
      events.map((event) => {
        const at = Date.parse(event.at);
        return {
          id: String(event.sequence),
          type: event.type,
          atMs: callStartMs != null && Number.isFinite(at) ? at - callStartMs : event.sequence,
          summary: '',
          payload: event.payload,
        };
      }),
    [events, callStartMs],
  );
  return (
    <WideDrawer
      open={segment != null}
      title={segment ? `Segment ${segment.index}: ${segment.label}` : 'Segment'}
      onClose={onClose}
    >
      {segment && (
        <div className="ds-stack">
          <KeyValueGrid
            items={[
              { label: 'Role', value: humaniseEnum(segment.role) },
              { label: 'Reason', value: REASON_LABELS[segment.reason] ?? segment.reason },
              { label: 'Agent', value: segment.agentId, mono: true, copy: segment.agentId },
              {
                label: 'Release',
                value: shortenId(segment.releaseId),
                mono: true,
                copy: segment.releaseId,
              },
              {
                label: 'Pool',
                value: segment.poolId ? shortenId(segment.poolId) : null,
                mono: true,
              },
              { label: 'Member', value: segment.memberId, mono: true },
              { label: 'Language', value: segment.language },
              { label: 'Started', value: <Duration ms={segment.startMs} /> },
              {
                label: 'Duration',
                value: segment.durationMs == null ? null : <Duration ms={segment.durationMs} />,
              },
              { label: 'Ended', value: segment.ended ? humaniseEnum(segment.ended) : null },
              { label: 'End reason', value: segment.endReason, mono: true },
              { label: 'Turns', value: segment.turns },
            ]}
          />
          <SectionCard title="Cost">
            <KeyValueGrid columns={3} items={costRows(cost)} />
            {Object.keys(segment.usage).length > 0 && (
              <KeyValueGrid
                columns={3}
                items={Object.entries(segment.usage).map(([meter, quantity]) => ({
                  label: meter,
                  value: quantity.toLocaleString('en-IN'),
                  mono: true,
                }))}
              />
            )}
          </SectionCard>
          <SectionCard title="Transcript" padding="flush">
            {lines.length ? (
              <Conversation lines={lines} />
            ) : (
              <EmptyStateV2 variant="unavailable" title="No transcript for this segment">
                No transcript line is tagged with this segment (calls recorded before routing
                visibility have no tags).
              </EmptyStateV2>
            )}
          </SectionCard>
          <SectionCard title="Events" description={`${events.length} routing events`}>
            {timeline.length ? (
              <Timeline events={timeline} groupBy="minute" pageSize={25} />
            ) : (
              <EmptyStateV2 variant="first-run" title="No events for this segment" />
            )}
          </SectionCard>
        </div>
      )}
    </WideDrawer>
  );
}
