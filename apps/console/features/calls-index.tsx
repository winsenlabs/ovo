'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCursorList } from '../lib/data/use-cursor-list';
import {
  callsKpis,
  callsOverTime,
  endReasonTop,
  routingFilterUnavailable,
  type CallRow,
} from '../lib/derive/calls';
import { loadRoutingPoints, loadRoutingStatus } from '../lib/data/call-route-api';
import type { RoutingPointOption, RoutingStatusLite } from '../lib/types/call-route';
import { routingAvailability } from '../app/(console)/calls/calls-routing-filters';
import {
  loadAgentChoices,
  loadAgentReleaseOptions,
} from '../components/operations/agent-release-options';
import { useSession } from '../components/shell/session-provider';
import { LiveCallForm } from '../components/operations/live-call-form';
import { Drawer } from '../components/ui/drawer';
import { PageHeader } from '../components/ui/layout';
import { DataTableV2 } from '../components/ui/data-table-v2';
import { dataTableRenderKey } from '../lib/data-table-remount-key';
import { PaginationV2 } from '../components/ui/pagination-v2';
import { EmptyStateV2 } from '../components/ui/feedback-v2';
import {
  SERVER_FILTERS,
  CallsFilterBar,
  activeChipCount,
} from '../app/(console)/calls/calls-filter-bar';
import { CallsOverview } from '../app/(console)/calls/calls-overview';
import { callColumns } from '../app/(console)/calls/calls-columns';
import { loadPluginOptions, type PluginOption } from '../app/(console)/calls/plugin-options';
import type { CustomRange, RangePreset } from '../components/ui/toolbar';

const RANGE_MS: Record<RangePreset, number | null> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  custom: null,
};

function withinRange(call: CallRow, preset: RangePreset, custom: CustomRange): boolean {
  if (!call.createdAt) return true;
  const created = Date.parse(call.createdAt);
  if (!Number.isFinite(created)) return true;
  if (preset === 'custom') {
    const from = custom.from ? Date.parse(custom.from) : -Infinity;
    const to = custom.to ? Date.parse(`${custom.to}T23:59:59`) : Infinity;
    return created >= from && created <= to;
  }
  const span = RANGE_MS[preset];
  return span == null ? true : Date.now() - created <= span;
}

/**
 * `/calls`: filters that are real query params (agent/kind/status/engine/carrier) hit the API and
 * stay URL-synced; call-ID search and the date range are client-side over the loaded page, same
 * as the KPI strip and charts below it (brief §3 CALLS — no new aggregate endpoint).
 */
export function CallsIndexFeature() {
  const identity = useSession();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [launchOpen, setLaunchOpen] = useState(false);
  // Two different keys for the same agent, never conflated: the filter Select sends a real
  // `agentId` to the API (B1 — `loadAgentReleaseOptions` is keyed by release id, which the API
  // doesn't accept as `agentId` and returns zero rows for), while the table's Agent column still
  // resolves a row's `releaseId` the only way it can.
  const [agentChoices, setAgentChoices] = useState<Map<string, string>>(new Map());
  const [agentsByRelease, setAgentsByRelease] = useState<Map<string, string>>(new Map());
  const [engines, setEngines] = useState<PluginOption[]>([]);
  const [carriers, setCarriers] = useState<PluginOption[]>([]);
  const [routingStatus, setRoutingStatus] = useState<RoutingStatusLite | null | 'pending'>(
    'pending',
  );
  const [routePoints, setRoutePoints] = useState<RoutingPointOption[]>([]);
  const [queryText, setQueryText] = useState(search.get('q') ?? '');
  const [range, setRange] = useState<RangePreset>((search.get('range') as RangePreset) || '30d');
  const [custom, setCustom] = useState<CustomRange>({
    from: search.get('from') ?? '',
    to: search.get('to') ?? '',
  });

  useEffect(() => {
    void loadAgentChoices()
      .then((choices) =>
        setAgentChoices(new Map(choices.map((choice) => [choice.id, choice.name]))),
      )
      .catch(() => setAgentChoices(new Map()));
    void loadAgentReleaseOptions()
      .then((options) =>
        setAgentsByRelease(new Map(options.map((option) => [option.id, option.agentName]))),
      )
      .catch(() => setAgentsByRelease(new Map()));
    void loadPluginOptions('engine')
      .then(setEngines)
      .catch(() => setEngines([]));
    void loadPluginOptions('carrier')
      .then(setCarriers)
      .catch(() => setCarriers([]));
    // A failed status reads as "routing off": the filters stay hidden instead of guessing.
    void loadRoutingStatus()
      .then((status) => {
        setRoutingStatus(status);
        if (status.enabled)
          return loadRoutingPoints()
            .then(setRoutePoints)
            .catch(() => setRoutePoints([]));
      })
      .catch(() => setRoutingStatus(null));
  }, []);

  const query = new URLSearchParams();
  for (const key of SERVER_FILTERS) {
    const value = search.get(key);
    if (value) query.set(key, value);
  }
  query.set('order', 'desc');
  const page = useCursorList<CallRow>(`/calls?${query}`, 50);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('cursor');
    router.push(`${pathname}?${next}`);
  };

  // M3: `setFilter` called once per key in a loop always reads the same `search` snapshot from
  // this render, so only the last call's deletion survives — one push built from every filter at
  // once is the only way "Clear all" actually clears all of them.
  const clearAllFilters = () => {
    const next = new URLSearchParams(search.toString());
    for (const key of SERVER_FILTERS) next.delete(key);
    next.delete('cursor');
    router.push(`${pathname}?${next}`);
  };

  const windowRows = useMemo(
    () =>
      page.items.filter(
        (call) =>
          withinRange(call, range, custom) &&
          (!queryText || call.id.toLowerCase().includes(queryText.toLowerCase())),
      ),
    [page.items, range, custom, queryText],
  );
  const kpis = useMemo(() => callsKpis(windowRows), [windowRows]);
  const overTime = useMemo(() => callsOverTime(windowRows), [windowRows]);
  const endReasons = useMemo(() => endReasonTop(windowRows), [windowRows]);
  const pointNames = useMemo(
    () => new Map(routePoints.map((point) => [point.id, point.name])),
    [routePoints],
  );
  const columns = useMemo(
    () => callColumns(agentsByRelease, pointNames),
    [agentsByRelease, pointNames],
  );
  const outcomesAbsent = routingFilterUnavailable(page);
  const routing = useMemo(
    () => ({
      availability: routingAvailability(routingStatus, outcomesAbsent),
      points: routePoints,
    }),
    [routingStatus, outcomesAbsent, routePoints],
  );
  const filtered = activeChipCount(search, queryText) > 0;

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Calls"
        title="Calls"
        description="Newest calls first. Server filters stay in the URL; the date range and search apply to what's loaded."
        actions={
          identity.role === 'admin' && (
            <button className="button primary" onClick={() => setLaunchOpen(true)}>
              Launch live call
            </button>
          )
        }
        onRefresh={page.refresh}
      />
      <CallsFilterBar
        search={search}
        setFilter={setFilter}
        onClearAll={clearAllFilters}
        queryText={queryText}
        setQueryText={setQueryText}
        agents={agentChoices}
        engines={engines}
        carriers={carriers}
        range={range}
        setRange={setRange}
        custom={custom}
        setCustom={setCustom}
        routing={routing}
      />
      <CallsOverview
        kpis={kpis}
        overTime={overTime}
        endReasons={endReasons}
        loading={page.status === 'loading'}
        error={page.error}
        onRetry={page.refresh}
      />
      <DataTableV2
        key={dataTableRenderKey(page.status === 'loading', page.error, windowRows.length)}
        label="Calls"
        rows={windowRows}
        rowKey={(call) => call.id}
        rowHref={(call) => `/calls/${encodeURIComponent(call.id)}`}
        loading={page.status === 'loading'}
        error={page.error}
        onRetry={page.refresh}
        empty={
          filtered ? (
            <EmptyStateV2 variant="filtered" title="No calls match. Clear filters." />
          ) : (
            <EmptyStateV2
              variant="first-run"
              title="No calls yet. Run a test call from an agent."
            />
          )
        }
        columns={columns}
      />
      <PaginationV2
        from={windowRows.length ? 1 : 0}
        to={windowRows.length}
        total={windowRows.length === page.items.length ? undefined : windowRows.length}
        hasPrevious={page.hasPrevious}
        hasNext={page.hasNext}
        busy={page.status === 'loading'}
        onPrevious={page.previous}
        onNext={page.next}
      />
      {identity.role === 'admin' && (
        <Drawer open={launchOpen} title="Launch live call" onClose={() => setLaunchOpen(false)}>
          <LiveCallForm
            role="admin"
            onLaunched={async () => {
              setLaunchOpen(false);
              await page.refresh();
            }}
          />
        </Drawer>
      )}
    </div>
  );
}
