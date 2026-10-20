'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { SelectField } from '../../../components/routing/fields';
import { RoutingUnavailablePage } from '../../../components/routing/routing-unavailable';
import { useSession } from '../../../components/shell/session-provider';
import { EmptyStateV2, ErrorState } from '../../../components/ui/feedback-v2';
import { PageHeader } from '../../../components/ui/layout';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { useRoutingStatus } from '../../../lib/data/use-routing-status';
import { loadDraft } from '../../../lib/derive/routing-defaults';
import { SimulatePanel } from './simulate-panel';

const DESCRIPTION =
  'Run a made-up caller through a release or a draft and see the path it takes, without placing a call.';

function Chosen({
  pointId,
  release,
  role,
  status,
  onPoint,
}: {
  pointId: string;
  release?: string;
  role: 'viewer' | 'editor' | 'admin';
  status: Parameters<typeof SimulatePanel>[0]['status'];
  onPoint: (id: string) => void;
}) {
  const points = useRoutingLoad(() => routingApi.points(), []);
  const point = useRoutingLoad(() => routingApi.point(pointId), [pointId]);
  const releases = useRoutingLoad(() => routingApi.releases(pointId), [pointId]);
  const pools = useRoutingLoad(() => routingApi.pools(), []);
  const list = points.state.status === 'ready' ? points.state.data : [];
  return (
    <>
      <SelectField
        id="sim-point"
        label="Routing point"
        value={pointId}
        options={list.map((p) => ({ value: p.id, label: p.draft.name }))}
        onChange={onPoint}
      />
      {point.state.status === 'error' && (
        <ErrorState message={point.state.message} onRetry={() => void point.reload()} />
      )}
      {point.state.status === 'ready' && releases.state.status !== 'loading' && (
        <SimulatePanel
          key={`${pointId}:${release ?? ''}`}
          pointId={pointId}
          pointName={point.state.data.point.draft.name}
          draft={loadDraft(point.state.data.point.draft).draft}
          releases={releases.state.status === 'ready' ? releases.state.data : []}
          status={status}
          role={role}
          pools={pools.state.status === 'ready' ? pools.state.data : []}
          initialRelease={release}
        />
      )}
    </>
  );
}

/** `/routing/simulate`: choose a point (or arrive from the designer with `?point=` or `?release=`). */
export function SimulateFeature() {
  const identity = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const { state, reload } = useRoutingStatus();
  const release = params.get('release') ?? undefined;
  const pointParam = params.get('point') ?? undefined;
  const points = useRoutingLoad(
    () => (state.kind === 'ready' ? routingApi.points() : Promise.resolve([])),
    [state.kind],
  );
  const byRelease = useRoutingLoad(
    () =>
      release && state.kind === 'ready' ? routingApi.release(release) : Promise.resolve(undefined),
    [release, state.kind],
  );
  if (state.kind !== 'ready')
    return (
      <RoutingUnavailablePage
        title="Simulate a call"
        state={state}
        onRetry={() => void reload()}
        description={DESCRIPTION}
      />
    );
  const list = points.state.status === 'ready' ? points.state.data : [];
  const pointId =
    pointParam ??
    (byRelease.state.status === 'ready' ? byRelease.state.data?.routingPointId : undefined) ??
    list[0]?.id;
  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Inbound"
        title="Simulate a call"
        description={DESCRIPTION}
        breadcrumb={[{ label: 'Routing', href: '/routing' }, { label: 'Simulate a call' }]}
      />
      {points.state.status === 'error' && (
        <ErrorState message={points.state.message} onRetry={() => void points.reload()} />
      )}
      {points.state.status === 'ready' && !pointId && (
        <EmptyStateV2
          title="No routing points yet"
          action={
            <a className="button primary" href="/routing">
              Create a routing point
            </a>
          }
        >
          Create a routing point first, then run callers through it here.
        </EmptyStateV2>
      )}
      {pointId && (
        <Chosen
          pointId={pointId}
          release={release}
          role={identity.role}
          status={state.status}
          onPoint={(id) => router.replace(`/routing/simulate?point=${encodeURIComponent(id)}`)}
        />
      )}
    </div>
  );
}
