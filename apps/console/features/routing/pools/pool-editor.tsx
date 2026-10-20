'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useAgents } from '../../../components/routing/agent-select';
import { editorGate, SaveActions } from '../../../components/routing/editor-states';
import { RoutingUnavailablePage } from '../../../components/routing/routing-unavailable';
import { useConfirmDialog } from '../../../components/ui/dialog';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { PageHeader } from '../../../components/ui/layout';
import { SectionCard } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { ApiError, type SessionIdentity } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { useRoutingStatus } from '../../../lib/data/use-routing-status';
import { freshKey } from '../../../lib/derive/routing-defaults';
import { blankMember, loadLabel, poolFacts, type PoolMember } from '../../../lib/derive/routing-pools';
import { useLeaveGuard } from '../../../lib/use-leave-guard';
import { ExplainDrawer } from './explain-drawer';
import { MemberDrawer } from './member-drawer';
import { PoolLoad } from './pool-load';
import { PoolMembers } from './pool-members';
import { PoolSettings } from './pool-settings';
import { usePool } from './use-pool';
import { useUtilisation } from './use-utilisation';

/** `/routing/pools/[poolId]`: members and attributes, live claims, and who would answer. */
export function PoolEditor({ poolId, role }: { poolId: string; role: SessionIdentity['role'] }) {
  const { state: availability, reload: reloadStatus } = useRoutingStatus();
  const router = useRouter();
  const api = usePool(poolId);
  const agents = useAgents();
  const util = useUtilisation(poolId, availability.kind === 'ready' && api.phase === 'ready');
  const points = useRoutingLoad(() => (availability.kind === 'ready' ? routingApi.points() : Promise.resolve([])), [availability.kind]);
  const [editing, setEditing] = useState<{ member: PoolMember; isNew: boolean }>();
  const [explaining, setExplaining] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { confirm, dialog } = useConfirmDialog();
  useLeaveGuard(api.dirty);
  const canEdit = role !== 'viewer';
  const definition = api.definition;
  const facts = useMemo(() => (definition ? poolFacts(definition) : undefined), [definition]);

  if (availability.kind !== 'ready') return <RoutingUnavailablePage title="Agent pool" state={availability} onRetry={() => void reloadStatus()} eyebrow="Routing" />;
  const gate = editorGate({ phase: api.phase, title: 'Agent pool', what: 'pool', kpis: ['Members', 'Taking calls', 'Active calls', 'Utilisation'], error: api.error, onRetry: () => void api.reload() });
  if (gate || !definition || !facts) return gate;

  const total = util.data?.total;
  const pointName = (id: string) => (points.state.status === 'ready' ? points.state.data.find((p) => p.id === id)?.draft.name : undefined) ?? id;
  const setMember = (member: PoolMember, isNew: boolean) =>
    api.edit((d) => ({ ...d, members: isNew ? [...d.members, member] : d.members.map((m) => (m.id === member.id ? member : m)) }));
  const remove = async () => {
    if (!(await confirm('Delete pool', `Delete “${definition.name}”? Routing points that use it must stop using it first.`))) return;
    try {
      await routingApi.removePool(poolId, api.version);
      router.push('/routing');
    } catch (failure) {
      const users = failure instanceof ApiError ? failure.details?.usedBy : undefined;
      const known = Array.isArray(users) ? await routingApi.points().catch(() => []) : [];
      const names = Array.isArray(users) ? (users as string[]).map((id) => known.find((p) => p.id === id)?.draft.name ?? id) : undefined;
      setProblem(names ? `This pool is still used by ${names.join(', ')}. Point them elsewhere first.` : failure instanceof Error ? failure.message : 'The pool could not be deleted.');
    }
  };
  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Routing"
        title={definition.name}
        description={definition.description}
        breadcrumb={[{ label: 'Routing', href: '/routing' }, { label: definition.name }]}
        meta={<span className="rt-badges"><StatusBadgeV2 tone="neutral" label={`Version ${api.version}`} />{api.dirty && <StatusBadgeV2 tone="warn" label="Unsaved changes" />}</span>}
        actions={
          <span className="button-row">
            <button type="button" className="button" onClick={() => setExplaining(true)}>Who would answer?</button>
            <SaveActions canEdit={canEdit} dirty={api.dirty} saving={api.saving} onSave={() => void api.save()} onDiscard={api.discard} />
            {canEdit && <button type="button" className="button danger" onClick={() => void remove()}>Delete</button>}
          </span>
        }
      />
      {api.saveError && <InlineAlert tone="danger">{api.saveError}</InlineAlert>}
      {problem && <InlineAlert tone="danger">{problem}</InlineAlert>}
      {api.conflict && (
        <InlineAlert tone="danger">
          <strong>This pool changed on the server.</strong> Your edits were not saved.
          <span className="button-row">
            <button type="button" className="button" onClick={api.takeTheirs}>Load the server version (lose my edits)</button>
            <button type="button" className="button" onClick={api.keepMine}>Keep my edits and save over it</button>
          </span>
        </InlineAlert>
      )}
      <KpiStrip>
        <KpiCard label="Members" value={facts.members} />
        <KpiCard label="Taking calls" value={facts.enabled} />
        <KpiCard label="Active calls" value={total ? total.active : null} footnote={util.unavailable ? 'Live calls are not available' : undefined} />
        <KpiCard label="Utilisation" value={total?.capacity ? `${Math.round((total.active / total.capacity) * 100)}%` : null} footnote={total ? loadLabel(total.active, total.capacity) : undefined} />
      </KpiStrip>
      <PoolLoad members={definition.members} data={util.data} stale={util.stale} unavailable={util.unavailable} onRetry={util.retry} />
      <SectionCard
        title="Members"
        description="Each member is an agent release with what it can serve."
        padding="flush"
        actions={canEdit ? <button type="button" className="button" disabled={definition.members.length >= 100} onClick={() => setEditing({ isNew: true, member: blankMember(freshKey('member', definition.members.map((m) => m.id)), definition.members[0]?.agent.agentId) })}>Add member</button> : undefined}
      >
        <PoolMembers
          members={definition.members}
          agents={agents.status === 'ready' ? agents.data : []}
          utilisation={util.data}
          canEdit={canEdit}
          onEdit={(member) => setEditing({ member, isNew: false })}
          onToggle={(member, enabled) => setMember({ ...member, enabled }, false)}
          onRemove={(member) => api.edit((d) => ({ ...d, members: d.members.filter((m) => m.id !== member.id) }))}
        />
      </SectionCard>
      <PoolSettings definition={definition} canEdit={canEdit} usedBy={(api.pool?.usedBy ?? []).map(pointName)} onChange={api.edit} />
      <MemberDrawer
        member={editing?.member}
        isNew={editing?.isNew ?? false}
        takenIds={editing?.isNew ? definition.members.map((m) => m.id) : []}
        agents={agents}
        onSave={(member) => {
          setMember(member, editing?.isNew ?? false);
          setEditing(undefined);
        }}
        onClose={() => setEditing(undefined)}
      />
      <ExplainDrawer open={explaining} poolId={poolId} definition={definition} onClose={() => setExplaining(false)} />
      {dialog}
    </div>
  );
}
