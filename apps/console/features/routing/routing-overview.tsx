'use client';
import { useMemo, useState } from 'react';
import { ClipManager } from '../../components/routing/clip-manager';
import { RoutingUnavailablePage } from '../../components/routing/routing-unavailable';
import { PageHeader } from '../../components/ui/layout';
import { SectionCard } from '../../components/ui/section-card';
import { Tabs, tabsFrom } from '../../components/ui/tabs';
import type { SessionIdentity } from '../../lib/api';
import { routingApi } from '../../lib/data/routing-api';
import { useRoutingLoad } from '../../lib/data/use-routing-load';
import { useRoutingStatus } from '../../lib/data/use-routing-status';
import { clipUsers, utilisationByPool } from '../../lib/derive/routing-overview';
import type { StatsWindow } from '../../lib/types/routing';
import { CreatePointDrawer, CreatePoolDrawer } from './create-drawers';
import { OverviewStats } from './overview-stats';
import { PointsTable } from './points-table';
import { PoolsTable } from './pools-table';

const TABS = tabsFrom({ points: 'Points', pools: 'Pools', clips: 'Hold clips' });
const DESCRIPTION =
  'Greet callers, work out their language and reason for calling, and hand them to the right agent or person.';

/** `/routing`: how routing is doing, then the points, pools and hold clips behind it. */
export function RoutingOverview({ role }: { role: SessionIdentity['role'] }) {
  const { state: availability, reload: reloadStatus } = useRoutingStatus();
  const enabled = availability.kind === 'ready';
  const [window, setWindow] = useState<StatsWindow>('24h');
  const [tab, setTab] = useState('points');
  const [creating, setCreating] = useState<'point' | 'pool'>();
  const canEdit = role !== 'viewer';

  const points = useRoutingLoad(
    () => (enabled ? routingApi.points() : Promise.resolve([])),
    [enabled],
  );
  const pools = useRoutingLoad(
    () => (enabled ? routingApi.pools() : Promise.resolve([])),
    [enabled],
  );
  const util = useRoutingLoad(
    () => (enabled ? routingApi.utilisationAll().catch(() => []) : Promise.resolve([])),
    [enabled],
  );
  const stats = useRoutingLoad(
    () => (enabled ? routingApi.stats(window) : Promise.reject(new Error('off'))),
    [enabled, window],
  );

  const pointRows = points.state.status === 'ready' ? points.state.data : [];
  const users = useMemo(() => clipUsers(pointRows), [pointRows]);
  const utilMap = useMemo(
    () => utilisationByPool(util.state.status === 'ready' ? util.state.data : []),
    [util.state],
  );

  if (availability.kind !== 'ready')
    return (
      <RoutingUnavailablePage
        title="Routing"
        state={availability}
        onRetry={() => void reloadStatus()}
        description={DESCRIPTION}
      />
    );
  const newPoint = canEdit ? (
    <button type="button" className="button primary" onClick={() => setCreating('point')}>
      New routing point
    </button>
  ) : undefined;
  const newPool = canEdit ? (
    <button type="button" className="button" onClick={() => setCreating('pool')}>
      New pool
    </button>
  ) : undefined;
  const failed = (s: { status: string; message?: string }) =>
    s.status === 'error' ? s.message : undefined;
  return (
    <div className="ds-stack rt-page">
      <PageHeader
        eyebrow="Inbound"
        title="Routing"
        description={DESCRIPTION}
        actions={
          canEdit ? (
            <span className="button-row">
              {newPoint}
              {newPool}
            </span>
          ) : undefined
        }
      />
      <OverviewStats
        load={stats.state}
        window={window}
        onWindow={setWindow}
        onRetry={() => void stats.reload()}
      />
      <SectionCard
        padding="flush"
        tabs={<Tabs items={TABS} current={tab} onSelect={setTab} panelId="routing-panel" />}
      >
        <div id="routing-panel" role="tabpanel">
          {tab === 'points' && (
            <PointsTable
              points={pointRows}
              loading={points.state.status === 'loading'}
              error={failed(points.state as never)}
              onRetry={() => void points.reload()}
              create={newPoint}
            />
          )}
          {tab === 'pools' && (
            <PoolsTable
              pools={pools.state.status === 'ready' ? pools.state.data : []}
              points={pointRows}
              utilisation={utilMap}
              loading={pools.state.status === 'loading'}
              error={failed(pools.state as never)}
              onRetry={() => void pools.reload()}
              create={newPool}
            />
          )}
          {tab === 'clips' && (
            <div className="rt-pad">
              <ClipManager canEdit={canEdit} users={users} />
            </div>
          )}
        </div>
      </SectionCard>
      <CreatePointDrawer open={creating === 'point'} onClose={() => setCreating(undefined)} />
      <CreatePoolDrawer open={creating === 'pool'} onClose={() => setCreating(undefined)} />
    </div>
  );
}
