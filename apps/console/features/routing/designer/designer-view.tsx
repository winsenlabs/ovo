'use client';
import { useMemo, useState } from 'react';
import { RoutingUnavailablePage } from '../../../components/routing/routing-unavailable';
import { EmptyStateV2, ErrorState, InlineAlert } from '../../../components/ui/feedback-v2';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { PageHeader } from '../../../components/ui/layout';
import { SectionCard } from '../../../components/ui/section-card';
import { Tabs, tabsFrom } from '../../../components/ui/tabs';
import type { SessionIdentity } from '../../../lib/api';
import { queuesApi } from '../../../lib/data/queues-api';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { useRoutingStatus } from '../../../lib/data/use-routing-status';
import { useTabParam } from '../../../lib/use-tab-param';
import { useLeaveGuard } from '../../../lib/use-leave-guard';
import { issueCountLabel } from '../../../components/routing/issue-list';
import { numbersOfPoint } from '../../../lib/derive/routing-numbers';
import { ConflictPanel } from './conflict-panel';
import { DesignerProvider, type DesignerEnv } from './designer-context';
import { DesignerBadges, DesignerKpis } from './designer-header';
import { HoldTransferTab } from './hold-transfer-tab';
import { LinesTab } from './lines-tab';
import { NumbersTab } from './numbers-tab';
import { PublishDrawer } from './publish-drawer';
import { QueuesTab } from './queues-tab';
import { ReleasesTab } from './releases-tab';
import { RouteMap } from './route-map';
import { SimulateTab } from './simulate-tab';
import { TreeTab } from './tree-tab';
import { useRoutingDraft } from './use-routing-draft';

const count = (label: string, n: number) => (n ? `${label} (${n})` : label);

/** `/routing/points/[pointId]`: the designer for one routing point. */
export function DesignerView({ pointId, role }: { pointId: string; role: SessionIdentity['role'] }) {
  const { state: availability, reload: reloadStatus } = useRoutingStatus();
  const enabled = availability.kind === 'ready';
  const api = useRoutingDraft(pointId);
  const { tab, setTab } = useTabParam('tree');
  const [openId, setOpenId] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useLeaveGuard(api.dirty);

  const pools = useRoutingLoad(() => (enabled ? routingApi.pools() : Promise.resolve([])), [enabled]);
  const agents = useRoutingLoad(() => (enabled ? routingApi.agents() : Promise.resolve([])), [enabled]);
  const credentials = useRoutingLoad(() => queuesApi.credentials().catch(() => []), []);
  const queues = useRoutingLoad(() => queuesApi.list().catch(() => []), []);
  const queueStatus = useRoutingLoad(() => queuesApi.status().catch(() => undefined), []);
  const audio = useRoutingLoad(() => (enabled ? routingApi.audio().catch(() => []) : Promise.resolve([])), [enabled, refresh]);
  const numbers = useRoutingLoad(() => (enabled ? routingApi.numbers() : Promise.resolve([])), [enabled, refresh]);
  const releases = useRoutingLoad(() => (enabled ? routingApi.releases(pointId) : Promise.resolve([])), [enabled, pointId, refresh]);

  const ready = <T,>(s: { status: string; data?: T }, fallback: T): T => (s.status === 'ready' ? (s as { data: T }).data : fallback);
  const releaseList = ready(releases.state, []);
  const latest = releaseList.reduce<(typeof releaseList)[number] | undefined>((best, r) => (!best || r.version > best.version ? r : best), undefined);
  const myNumbers = useMemo(() => numbersOfPoint(ready(numbers.state, []), pointId), [numbers.state, pointId]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = role !== 'viewer';

  if (availability.kind !== 'ready')
    return <RoutingUnavailablePage title="Routing point" state={availability} onRetry={() => void reloadStatus()} />;
  if (api.phase === 'loading')
    return (
      <div className="ds-stack">
        <PageHeader eyebrow="Routing" title="Routing point" />
        <KpiStrip>{['Questions', 'Pools used', 'Languages', 'Issues'].map((l) => <KpiCard key={l} label={l} loading />)}</KpiStrip>
      </div>
    );
  if (api.phase === 'missing')
    return (
      <div className="ds-stack">
        <PageHeader eyebrow="Routing" title="Routing point" />
        <EmptyStateV2 variant="filtered" title="This routing point does not exist" action={<a className="button" href="/routing">Back to routing</a>}>It may have been deleted.</EmptyStateV2>
      </div>
    );
  if (api.phase !== 'ready' || !api.draft || !api.index)
    return (
      <div className="ds-stack">
        <PageHeader eyebrow="Routing" title="Routing point" />
        <ErrorState message={api.error ?? 'The routing point could not be loaded.'} onRetry={() => void api.reload()} />
      </div>
    );

  const { draft, index } = api;
  const env: DesignerEnv = {
    draft,
    edit: api.edit,
    index,
    canEdit,
    status: availability.status,
    pools: ready(pools.state, []),
    agents: agents.state.status === 'ready' ? agents.state : agents.state.status === 'error' ? { status: 'error', message: agents.state.message } : { status: 'loading' },
    credentials: ready(credentials.state, []),
    queues: ready(queues.state, []),
    queueStatus: ready(queueStatus.state, undefined),
    audio: ready(audio.state, []),
  };
  const blockers = index.errors;
  const unchanged = latest !== undefined && latest.draftVersion === api.version && !api.dirty;
  const publishReason = blockers ? `Fix ${blockers} error${blockers === 1 ? '' : 's'} first` : unchanged ? `Nothing changed since v${latest?.version}` : undefined;
  const sec = index.bySection;
  const tabs = tabsFrom({
    tree: count('Tree', sec.node.length + sec.branch.length + sec.engine.length + sec.fallback.length),
    lines: count('Lines & languages', sec.languages.length + sec.lines.length + sec.agents.length + sec.limits.length),
    hold: count('Hold & transfer', sec.transfer.length + sec.hold.length),
    queues: count('Human queues', sec.queues.length),
    numbers: count('Numbers', myNumbers.length),
    releases: 'Releases',
    simulate: 'Simulate',
  });
  const open = (id: string) => {
    setOpenId(id);
    setTab('tree');
  };
  return (
    <DesignerProvider value={env}>
      <div className="ds-stack">
        <PageHeader
          eyebrow="Routing"
          title={draft.name}
          description={draft.description}
          breadcrumb={[{ label: 'Routing', href: '/routing' }, { label: draft.name }]}
          meta={<DesignerBadges version={api.version} latest={latest} dirty={api.dirty} index={index} validating={api.validating} />}
          actions={
            <span className="button-row">
              {canEdit && (
                <button type="button" className="button" disabled={!api.dirty || api.saving} onClick={() => void api.save()}>
                  {api.saving ? 'Saving…' : 'Save'}
                </button>
              )}
              {api.dirty && canEdit && <button type="button" className="button" onClick={api.discard}>Discard changes</button>}
              <button type="button" className="button" onClick={() => setTab('simulate')}>Simulate</button>
              {canEdit && (
                <button type="button" className="button primary" disabled={publishReason !== undefined && !api.dirty} title={publishReason} onClick={() => setPublishing(true)}>
                  Publish…
                </button>
              )}
            </span>
          }
        />
        {api.saveError && <InlineAlert tone="danger">{api.saveError}</InlineAlert>}
        {api.conflict && <ConflictPanel conflict={api.conflict} onTakeTheirs={api.takeTheirs} onKeepMine={api.keepMine} />}
        {!canEdit && <InlineAlert tone="info">You can read this point but not change it. Editors can.</InlineAlert>}
        {publishReason && canEdit && !api.dirty && <p className="muted">Publish is unavailable: {publishReason}.</p>}
        <DesignerKpis draft={draft} index={index} numbers={numbers.state.status === 'ready' ? numbers.state.data : undefined} />
        <RouteMap onOpen={open} />
        <SectionCard padding="flush" tabs={<Tabs items={tabs} current={tab} onSelect={setTab} panelId="designer-panel" />}>
          <div id="designer-panel" role="tabpanel">
            {tab === 'tree' && <TreeTab openId={openId} onOpen={setOpenId} />}
            {tab === 'lines' && <LinesTab />}
            {tab === 'hold' && <HoldTransferTab pointId={pointId} />}
            {tab === 'queues' && <QueuesTab />}
            {tab === 'numbers' && (
              <NumbersTab pointId={pointId} pointName={draft.name} numbers={ready(numbers.state, [])} isAdmin={role === 'admin'} refreshKey={refresh} onChanged={() => setRefresh((n) => n + 1)} />
            )}
            {tab === 'releases' && <ReleasesTab pointId={pointId} numbers={ready(numbers.state, [])} canEdit={canEdit} refreshKey={refresh} onPublish={() => setPublishing(true)} />}
            {tab === 'simulate' && <SimulateTab pointId={pointId} pointName={draft.name} releases={releaseList} role={role} />}
          </div>
        </SectionCard>
        <PublishDrawer
          open={publishing}
          onClose={() => setPublishing(false)}
          pointId={pointId}
          draftVersion={api.version}
          dirty={api.dirty}
          onSave={api.save}
          saving={api.saving}
          onPublished={() => setRefresh((n) => n + 1)}
          onBindNumbers={() => {
            setPublishing(false);
            setTab('numbers');
          }}
        />
        <span className="sr-only" aria-live="polite">{issueCountLabel(index.errors, index.warnings)}</span>
      </div>
    </DesignerProvider>
  );
}
