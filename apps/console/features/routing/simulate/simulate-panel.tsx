'use client';
import { routingPoolIds, type RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { useEffect, useMemo, useState } from 'react';
import { RoutingUnavailable } from '../../../components/routing/routing-unavailable';
import {
  EmptyStateV2,
  ErrorState,
  InlineAlert,
  Skeleton,
} from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { routingApi } from '../../../lib/data/routing-api';
import { blankSimForm, engineSlots, type SimForm } from '../../../lib/derive/routing-simulate';
import { loadDraft } from '../../../lib/derive/routing-defaults';
import type { PoolRecord, ReleaseSummary, RoutingStatus } from '../../../lib/types/routing';
import { AnswersEditor } from './answers-editor';
import { DRAFT, SimTargetSections } from './sim-sections';
import { FaultsEditor } from './faults-editor';
import { ScriptEditor } from './script-editor';
import { SimResults } from './sim-results';
import { useRouterZone } from './use-router-zone';
import { useSimulation, withAnswer } from './use-simulation';

/**
 * The route tester. Pick what to run (the draft with its unsaved edits, or a release), script the
 * caller, decide what the engines answer, run, and read the path node by node.
 */
export function SimulatePanel({
  pointId,
  pointName,
  draft,
  releases,
  status,
  role,
  pools,
  initialRelease,
}: {
  pointId: string;
  pointName: string;
  draft: RoutingPointDraft;
  releases: readonly ReleaseSummary[];
  status: RoutingStatus;
  role: 'viewer' | 'editor' | 'admin';
  pools: readonly PoolRecord[];
  initialRelease?: string;
}) {
  const [form, setForm] = useState<SimForm>(() =>
    blankSimForm(
      initialRelease
        ? { kind: 'release', routingReleaseId: initialRelease }
        : { kind: 'draft', pointId },
    ),
  );
  const [ranWith, setRanWith] = useState<SimForm>(form);
  const [snapshot, setSnapshot] = useState<
    { id: string; draft: RoutingPointDraft } | { id: string; error: string }
  >();
  const zone = useRouterZone(draft.router.agentId);
  const { run, execute } = useSimulation({ timeZone: zone, draft });
  const releaseId = form.target.kind === 'release' ? form.target.routingReleaseId : undefined;
  useEffect(() => {
    if (!releaseId) return;
    let live = true;
    void routingApi.release(releaseId).then(
      (release) => live && setSnapshot({ id: releaseId, draft: loadDraft(release.snapshot).draft }),
      (failure) =>
        live &&
        setSnapshot({
          id: releaseId,
          error: failure instanceof Error ? failure.message : 'The release could not be loaded.',
        }),
    );
    return () => {
      live = false;
    };
  }, [releaseId]);
  const tree = releaseId
    ? snapshot && snapshot.id === releaseId && 'draft' in snapshot
      ? snapshot.draft
      : undefined
    : draft;
  const slots = useMemo(() => (tree ? engineSlots(tree) : []), [tree]);
  const used = useMemo(() => (tree ? new Set(routingPoolIds(tree)) : new Set<string>()), [tree]);
  const canRun = role !== 'viewer';
  const isAdmin = role === 'admin';
  const set = (patch: Partial<SimForm>) => setForm((f) => ({ ...f, ...patch }));
  const start = (next: SimForm) => {
    setRanWith(next);
    void execute(next);
  };
  const branchesOf = (node: string) =>
    tree?.nodes.find((n) => n.id === node)?.branches.map((b) => b.key) ?? [];

  if (status.simulate && !status.simulate.enabled)
    return <RoutingUnavailable state={{ kind: 'disabled' }} what="Route simulation" />;
  const targetOptions = [
    { value: DRAFT, label: 'This draft, with unsaved edits' },
    ...releases.map((r) => ({ value: r.id, label: `Release v${r.version}` })),
  ];
  return (
    <div className="rt-sim">
      <div className="rt-stack rt-sim-form">
        {!canRun && (
          <InlineAlert tone="info">
            Editors can run simulations; viewers can read results.
          </InlineAlert>
        )}
        <fieldset className="rt-readonly rt-stack" disabled={!canRun}>
          <SimTargetSections
            form={form}
            pointId={pointId}
            targetOptions={targetOptions}
            releaseId={releaseId}
            loadError={snapshot && 'error' in snapshot && snapshot.id === releaseId ? snapshot.error : undefined}
            zone={zone}
            onChange={set}
          />
          <SectionCard title="What the caller does">
            <ScriptEditor turns={form.turns} onChange={(turns) => set({ turns })} />
          </SectionCard>
          <SectionCard title="What the engines answer">
            {!tree ? (
              <Skeleton shape="block" />
            ) : (
              <AnswersEditor
                slots={slots}
                form={form}
                onChange={setForm}
                status={status}
                isAdmin={isAdmin}
                languages={tree.language.allowed}
              />
            )}
          </SectionCard>
          <details className="rt-details">
            <summary>What if…</summary>
            {tree && (
              <FaultsEditor
                form={form}
                onChange={setForm}
                draft={tree}
                pools={pools.filter((p) => used.has(p.id))}
              />
            )}
          </details>
        </fieldset>
        <div className="rt-run">
          <button
            type="button"
            className="button primary"
            disabled={!canRun || run.status === 'running' || !tree}
            onClick={() => start(form)}
          >
            {run.status === 'running' ? 'Running…' : 'Run the simulation'}
          </button>
        </div>
      </div>
      <div className="rt-sim-result" aria-live="polite" aria-label={`Simulation of ${pointName}`}>
        {run.status === 'idle' && (
          <EmptyStateV2 title="Nothing run yet">
            Script a caller on the left and run it to see the path the router takes.
          </EmptyStateV2>
        )}
        {run.status === 'running' && <Skeleton shape="block" />}
        {run.status === 'error' && (
          <ErrorState
            title="The simulation did not run"
            message={run.message}
            onRetry={() => start(form)}
          />
        )}
        {run.status === 'unavailable' && <InlineAlert tone="warn">{run.reason}</InlineAlert>}
        {run.status === 'blocked' && (
          <ErrorState
            title="The draft cannot be run yet"
            message={`${run.blockers.length} problem${run.blockers.length === 1 ? '' : 's'} would block a publish: ${run.blockers.map((b) => b.message).join('; ')}`}
          />
        )}
        {run.status === 'done' && (
          <SimResults
            result={run.result}
            form={ranWith}
            timeZone={zone}
            branchesOf={branchesOf}
            onAnswer={(answer) => {
              const next = withAnswer(form, answer);
              setForm(next);
              start(next);
            }}
          />
        )}
      </div>
    </div>
  );
}
