'use client';
import { useState } from 'react';
import { editorGate, SaveActions } from '../../../components/routing/editor-states';
import { issueCountLabel } from '../../../components/routing/issue-list';
import { RoutingUnavailablePage } from '../../../components/routing/routing-unavailable';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { PageHeader } from '../../../components/ui/layout';
import { SectionCard } from '../../../components/ui/section-card';
import { Tabs, tabsFrom } from '../../../components/ui/tabs';
import type { SessionIdentity } from '../../../lib/api';
import { useRoutingStatus } from '../../../lib/data/use-routing-status';
import { useLeaveGuard } from '../../../lib/use-leave-guard';
import { useTabParam } from '../../../lib/use-tab-param';
import { ConflictPanel } from './conflict-panel';
import { DesignerProvider, type DesignerEnv } from './designer-context';
import { useDesignerData } from './designer-data';
import { DesignerBadges, DesignerKpis } from './designer-header';
import { DesignerPanel } from './designer-panel';
import { PublishDrawer } from './publish-drawer';
import { RouteMap } from './route-map';
import { useRoutingDraft } from './use-routing-draft';

const count = (label: string, n: number) => (n ? `${label} (${n})` : label);

/** `/routing/points/[pointId]`: the designer for one routing point. */
export function DesignerView({ pointId, role }: { pointId: string; role: SessionIdentity['role'] }) {
  const { state: availability, reload: reloadStatus } = useRoutingStatus();
  const api = useRoutingDraft(pointId);
  const { tab, setTab } = useTabParam('tree');
  const [openId, setOpenId] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const data = useDesignerData(pointId, availability.kind === 'ready', refresh);
  useLeaveGuard(api.dirty);

  if (availability.kind !== 'ready')
    return <RoutingUnavailablePage title="Routing point" state={availability} onRetry={() => void reloadStatus()} />;
  const gate = editorGate({
    phase: api.phase,
    title: 'Routing point',
    what: 'routing point',
    kpis: ['Questions', 'Pools used', 'Languages', 'Issues'],
    error: api.error,
    onRetry: () => void api.reload(),
  });
  const { draft, index } = api;
  if (gate || !draft || !index) return gate;

  const canEdit = role !== 'viewer';
  const env: DesignerEnv = { draft, edit: api.edit, index, canEdit, status: availability.status, ...data.reference };
  const blockers = index.errors;
  const unchanged = data.latest !== undefined && data.latest.draftVersion === api.version && !api.dirty;
  const publishReason = blockers ? `Fix ${blockers} error${blockers === 1 ? '' : 's'} first` : unchanged ? `Nothing changed since v${data.latest?.version}` : undefined;
  const sec = index.bySection;
  const tabs = tabsFrom({
    tree: count('Tree', sec.node.length + sec.branch.length + sec.engine.length + sec.fallback.length),
    lines: count('Lines & languages', sec.languages.length + sec.lines.length + sec.agents.length + sec.limits.length),
    hold: count('Hold & transfer', sec.transfer.length + sec.hold.length),
    queues: count('Human queues', sec.queues.length),
    numbers: count('Numbers', data.mine.length),
    releases: 'Releases',
    simulate: 'Simulate',
  });
  const open = (id: string | undefined) => {
    setOpenId(id);
    if (id) setTab('tree');
  };
  return (
    <DesignerProvider value={env}>
      <div className="ds-stack">
        <PageHeader
          eyebrow="Routing"
          title={draft.name}
          description={draft.description}
          breadcrumb={[{ label: 'Routing', href: '/routing' }, { label: draft.name }]}
          meta={<DesignerBadges version={api.version} latest={data.latest} dirty={api.dirty} index={index} validating={api.validating} />}
          actions={
            <span className="button-row">
              <SaveActions canEdit={canEdit} dirty={api.dirty} saving={api.saving} onSave={() => void api.save()} onDiscard={api.discard} />
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
        <DesignerKpis draft={draft} index={index} numbers={data.numbersLoaded ? data.numbers : undefined} />
        <RouteMap onOpen={open} />
        <SectionCard padding="flush" tabs={<Tabs items={tabs} current={tab} onSelect={setTab} panelId="designer-panel" />}>
          <div id="designer-panel" role="tabpanel">
            <DesignerPanel
              tab={tab}
              pointId={pointId}
              pointName={draft.name}
              role={role}
              openId={openId}
              onOpen={open}
              numbers={data.numbers}
              releases={data.releases}
              refresh={refresh}
              onChanged={() => setRefresh((n) => n + 1)}
              onPublish={() => setPublishing(true)}
            />
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
