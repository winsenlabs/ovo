'use client';
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { CallRouteState } from '../lib/data/call-route-api';
import {
  buildHuman,
  buildKpis,
  buildTransferRows,
  costRollup,
  eventsForSegment,
  hasRouteData,
  TARGET_LABELS,
} from '../lib/derive/call-route-summary';
import { buildTimeline } from '../lib/derive/call-route';
import { buildRoutePath, segmentOf } from '../lib/derive/call-route-path';
import { toConversationLines, type CallEvidence } from '../lib/derive/call-detail';
import { humaniseEnum } from '../lib/status';
import { KpiCard, KpiStrip } from '../components/ui/kpi';
import { Duration, Money } from '../components/ui/display';
import { EmptyStateV2, ErrorState, InlineAlert, Skeleton } from '../components/ui/feedback-v2';
import { SectionCard } from '../components/ui/section-card';
import { SegmentTimeline } from '../components/inspector/route-timeline';
import { RoutePathChips } from '../components/inspector/route-path-chips';
import { SegmentsTable } from '../components/inspector/route-segments-table';
import { SegmentDrawer } from '../components/inspector/route-segment-drawer';
import { TransfersTable } from '../components/inspector/route-transfers-table';
import { HumanCard } from '../components/inspector/route-human-card';
import { ROUTE_EVENT_CAP, type CallRouteResponse } from '../lib/types/call-route';

function RouteLoading() {
  return (
    <div className="ds-stack">
      <KpiStrip>
        {Array.from({ length: 6 }, (_, index) => (
          <KpiCard key={index} label="" value={null} loading />
        ))}
      </KpiStrip>
      <Skeleton shape="chart" width="100%" />
    </div>
  );
}

/** The `?segment=` deep link: the open segment's index, or null. */
function useOpenSegment() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const parsed = Number(search.get('segment'));
  const open =
    search.get('segment') != null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  const setOpen = useCallback(
    (index: number | null) => {
      const next = new URLSearchParams(search.toString());
      if (index == null) next.delete('segment');
      else next.set('segment', String(index));
      router.replace(`${pathname}?${next}`, { scroll: false });
    },
    [pathname, router, search],
  );
  return [open, setOpen] as const;
}

function RouteBody({
  data,
  evidence,
  names,
}: {
  data: CallRouteResponse;
  evidence: CallEvidence;
  names: ReadonlyMap<string, string>;
}) {
  const [openIndex, setOpen] = useOpenSegment();
  const call = evidence.call;
  const timeline = useMemo(
    () => buildTimeline(data, { createdAt: call.createdAt, durationMs: call.durationMs }, names),
    [data, call.createdAt, call.durationMs, names],
  );
  const kpis = useMemo(() => buildKpis(data), [data]);
  const cost = useMemo(() => costRollup(data), [data]);
  const path = useMemo(() => buildRoutePath(data.route, data.events), [data]);
  const transfers = useMemo(() => buildTransferRows(data), [data]);
  const human = useMemo(() => buildHuman(data), [data]);
  const segment = timeline.segments.find((item) => item.index === openIndex) ?? null;
  const lines = useMemo(() => {
    const all = toConversationLines(evidence.transcript, undefined);
    return all.filter((_, position) => segmentOf(evidence.transcript?.[position]) === openIndex);
  }, [evidence.transcript, openIndex]);
  const callStart = call.createdAt ? Date.parse(call.createdAt) : NaN;
  const target = kpis.target;
  return (
    <div className="ds-stack">
      <KpiStrip>
        <KpiCard
          label="Route target"
          value={target ? (TARGET_LABELS[target] ?? humaniseEnum(target)) : null}
          footnote={
            kpis.degraded
              ? `Degraded: ${humaniseEnum(kpis.degraded)}`
              : `${path.steps.length} routing steps`
          }
        />
        <KpiCard label="Segments" value={kpis.segments} />
        <KpiCard
          label="Transfers"
          value={kpis.transfersRequested}
          footnote={`${kpis.transfersRefused} refused · ${kpis.transfersConnected} connected`}
        />
        <KpiCard
          label="Hold total"
          value={kpis.holdTotalMs == null ? null : <Duration ms={kpis.holdTotalMs} />}
        />
        <KpiCard
          label="Person wait"
          value={kpis.waitMs == null ? null : <Duration ms={kpis.waitMs} />}
          footnote={
            kpis.talkMs == null ? undefined : (
              <>
                talk <Duration ms={kpis.talkMs} />
              </>
            )
          }
        />
        <KpiCard
          label="Cost, all segments"
          value={
            cost.totalPaise == null ? null : (
              <Money minorUnits={cost.totalPaise} currency={cost.currency} />
            )
          }
          footnote={cost.callLevelPaise > 0 ? 'Includes call-level usage' : undefined}
        />
      </KpiStrip>
      {data.eventsTruncated && (
        <InlineAlert tone="info">
          Showing the first {ROUTE_EVENT_CAP} events. Later routing events are not listed.
        </InlineAlert>
      )}
      <SegmentTimeline timeline={timeline} />
      <SectionCard
        title="Route taken"
        description="The node each engine decided, with its confidence."
      >
        <RoutePathChips path={path} target={target} />
      </SectionCard>
      <SegmentsTable segments={timeline.segments} currency={cost.currency} onOpen={setOpen} />
      <TransfersTable rows={transfers} />
      {human && <HumanCard human={human} />}
      <SegmentDrawer
        segment={segment}
        cost={data.segments.find((item) => item.index === openIndex)?.cost ?? null}
        events={segment ? eventsForSegment(data.events, segment.index) : []}
        lines={lines}
        callStartMs={Number.isFinite(callStart) ? callStart : null}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/**
 * The "Route & segments" tab: how the call was routed, who handled each stretch of it, every
 * transfer and the person who joined. The data is the API's `/calls/:id/segments`, loaded once by
 * the inspector so the header chip, this tab and the transcript dividers agree.
 */
export function CallRoutePanel({
  route,
  evidence,
  names,
}: {
  route: CallRouteState & { refresh: () => void };
  evidence: CallEvidence;
  names: ReadonlyMap<string, string>;
}) {
  if (route.status === 'loading') return <RouteLoading />;
  if (route.status === 'error')
    return (
      <ErrorState
        title="Route data unavailable"
        message={route.error.message}
        onRetry={route.refresh}
        stillWorks="The transcript, latency and cost tabs are unaffected."
      />
    );
  if (!route.data.available)
    return (
      <EmptyStateV2 variant="unavailable" title="Route data is not stored here">
        This installation does not store call outcomes (PostgreSQL only), so the route and segments
        of this call were not kept.
      </EmptyStateV2>
    );
  if (!hasRouteData(route.data))
    return (
      <EmptyStateV2 variant="first-run" title="This call was not routed">
        It went straight to one agent, so there is no route, segment or transfer to show.
      </EmptyStateV2>
    );
  return <RouteBody data={route.data} evidence={evidence} names={names} />;
}

/** The route evidence "Export evidence" adds to the call's evidence JSON (nothing for a direct call). */
export function routeEvidence(route: CallRouteState): {
  routing?: Omit<CallRouteResponse, 'callId' | 'available'>;
} {
  if (route.status !== 'ready' || !hasRouteData(route.data)) return {};
  const { callId: _callId, available: _available, ...rest } = route.data;
  return { routing: rest };
}

/** "Export evidence": the call's evidence as a JSON data link, with the route evidence added. */
export function evidenceDownloadHref(evidence: CallEvidence, route: CallRouteState): string {
  const body = { ...evidence, ...routeEvidence(route) };
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(body, null, 2))}`;
}
