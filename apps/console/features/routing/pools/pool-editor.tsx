'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useAgents } from '../../../components/routing/agent-select';
import { RoutingUnavailablePage } from '../../../components/routing/routing-unavailable';
import { TagsField, TextAreaField, TextField } from '../../../components/routing/fields';
import { ProgressMeter } from '../../../components/charts/meter';
import { useConfirmDialog } from '../../../components/ui/dialog';
import { EmptyStateV2, ErrorState, InlineAlert } from '../../../components/ui/feedback-v2';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { PageHeader } from '../../../components/ui/layout';
import { SectionCard } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { ApiError, type SessionIdentity } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { useRoutingStatus } from '../../../lib/data/use-routing-status';
import { useLeaveGuard } from '../../../lib/use-leave-guard';
import { freshKey } from '../../../lib/derive/routing-defaults';
import { blankMember, loadLabel, poolFacts, type PoolMember } from '../../../lib/derive/routing-pools';
import { ExplainDrawer } from './explain-drawer';
import { MemberDrawer } from './member-drawer';
import { PoolMembers } from './pool-members';
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
  const agentList = agents.status === 'ready' ? agents.data : [];

  if (availability.kind !== 'ready') return <RoutingUnavailablePage title="Agent pool" state={availability} onRetry={() => void reloadStatus()} eyebrow="Routing" />;
  if (api.phase === 'loading') return <div className="ds-stack"><PageHeader eyebrow="Routing" title="Agent pool" /><KpiStrip>{['Members', 'Enabled', 'Active calls', 'Utilisation'].map((l) => <KpiCard key={l} label={l} loading />)}</KpiStrip></div>;
  if (api.phase === 'missing') return <div className="ds-stack"><PageHeader eyebrow="Routing" title="Agent pool" /><EmptyStateV2 variant="filtered" title="This pool does not exist" action={<a className="button" href="/routing">Back to routing</a>}>It may have been deleted.</EmptyStateV2></div>;
  if (api.phase !== 'ready' || !definition || !facts) return <div className="ds-stack"><PageHeader eyebrow="Routing" title="Agent pool" /><ErrorState message={api.error ?? 'The pool could not be loaded.'} onRetry={() => void api.reload()} /></div>;

  const total = util.data?.total;
  const setMember = (member: PoolMember, isNew: boolean) =>
    api.edit((d) => ({ ...d, members: isNew ? [...d.members, member] : d.members.map((m) => (m.id === member.id ? member : m)) }));
  const remove = async () => {
    if (!(await confirm('Delete pool', `Delete “${definition.name}”? Routing points that use it must stop using it first.`))) return;
    try {
      await routingApi.removePool(poolId, api.version);
      router.push('/routing');
    } catch (failure) {
      const users = failure instanceof ApiError ? failure.details?.usedBy : undefined;
      const names = Array.isArray(users) ? (users as string[]).map((id) => points.state.status === 'ready' ? (points.state.data.find((p) => p.id === id)?.draft.name ?? id) : id) : undefined;
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
            {canEdit && <button type="button" className="button primary" disabled={!api.dirty || api.saving} onClick={() => void api.save()}>{api.saving ? 'Saving…' : 'Save'}</button>}
            {canEdit && api.dirty && <button type="button" className="button" onClick={api.discard}>Discard changes</button>}
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
      <SectionCard
        title="Live load"
        description="Calls each member holds now, refreshed every 10 seconds."
        actions={util.stale ? <span className="rt-stale"><StatusBadgeV2 tone="warn" size="sm" label="Stale" /><button type="button" className="button small" onClick={util.retry}>Retry</button></span> : undefined}
      >
        {util.data ? (
          <ul className="rt-bars" aria-label="Load per member">
            {definition.members.map((m) => {
              const now = util.data!.members.find((x) => x.memberId === m.id);
              return (
                <li key={m.id}>
                  <ProgressMeter label={m.id} value={now?.active ?? 0} max={m.capacity ?? Math.max(1, now?.active ?? 1)} valueLabel={loadLabel(now?.active ?? 0, m.capacity)} />
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyStateV2 variant={util.unavailable ? 'unavailable' : 'first-run'} title={util.unavailable ? 'Live load is not available' : 'Loading live load…'} />
        )}
      </SectionCard>
      <SectionCard title="Members" description="Each member is an agent release with what it can serve." padding="flush" actions={canEdit ? <button type="button" className="button" disabled={definition.members.length >= 100} onClick={() => setEditing({ isNew: true, member: blankMember(freshKey('member', definition.members.map((m) => m.id)), definition.members[0]?.agent.agentId) })}>Add member</button> : undefined}>
        <PoolMembers
          members={definition.members}
          agents={agentList}
          utilisation={util.data}
          canEdit={canEdit}
          onEdit={(member) => setEditing({ member, isNew: false })}
          onToggle={(member, enabled) => setMember({ ...member, enabled }, false)}
          onRemove={(member) => api.edit((d) => ({ ...d, members: d.members.filter((m) => m.id !== member.id) }))}
        />
      </SectionCard>
      <SectionCard title="Pool settings">
        <fieldset className="rt-readonly rt-stack" disabled={!canEdit}>
          <TextField id="pool-name" label="Name" value={definition.name} onChange={(name) => api.edit((d) => ({ ...d, name }))} />
          <TextAreaField id="pool-description" label="Description" rows={2} value={definition.description ?? ''} onChange={(description) => api.edit((d) => ({ ...d, description: description || undefined }))} />
          <TagsField id="pool-fallback" label="If nobody speaks the caller's language, try" values={definition.languageFallback} placeholder="en" help="Languages in order, up to 5." onChange={(languageFallback) => api.edit((d) => ({ ...d, languageFallback }))} />
          <p className="muted">
            {api.pool?.usedBy?.length
              ? `Used by ${api.pool.usedBy.map((id) => (points.state.status === 'ready' ? (points.state.data.find((p) => p.id === id)?.draft.name ?? id) : id)).join(', ')}.`
              : 'No routing point names this pool yet.'}
          </p>
        </fieldset>
      </SectionCard>
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
