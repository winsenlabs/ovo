'use client';
import { useMemo, useState } from 'react';
import { PageHeader } from '../../components/ui/layout';
import { useSession } from '../../components/shell/session-provider';
import {
  useHomeAgents,
  useHomeBudgets,
  useHomeCallbacks,
  useHomeCalls,
  useHomeComplaints,
  useHomeCredentials,
  useHomeInfrastructure,
  useHomePerformance,
  useHomeReadiness,
  useHomeRatios,
  useHomeReleaseAgentMap,
} from './home/use-home-data';
import { HomeKpiSection } from './home/kpi-section';
import { HomeCallsChartSection } from './home/calls-chart-section';
import { HomeSecondarySection } from './home/secondary-section';
import { HomeAttentionSection } from './home/attention-section';

const RANGE_OPTIONS = [
  { value: 1, label: '24h' },
  { value: 7, label: '7d' },
] as const;

export function HomeDashboard() {
  const identity = useSession();
  const [rangeDays, setRangeDays] = useState<1 | 7>(7);
  const isAdmin = identity.role === 'admin';
  const isEditorUp = identity.role === 'admin' || identity.role === 'editor';

  const callsState = useHomeCalls(rangeDays);
  const agentsState = useHomeAgents();
  const performanceState = useHomePerformance();
  const infrastructureState = useHomeInfrastructure();
  const callbacksState = useHomeCallbacks();
  const complaintsState = useHomeComplaints(isEditorUp);
  const ratiosState = useHomeRatios(isEditorUp);
  const budgetsState = useHomeBudgets(isAdmin);
  const credentialsState = useHomeCredentials(isAdmin);

  const agents = agentsState.status === 'ready' ? agentsState.data : [];
  const agentIds = useMemo(() => agents.map((agent) => agent.id), [agents]);
  const readinessState = useHomeReadiness(agentIds);
  const releaseAgentMapState = useHomeReleaseAgentMap(agentIds);

  const calls = callsState.status === 'ready' ? callsState.data : [];
  const recentCalls = useMemo(() => calls.slice(0, 10), [calls]);
  // `CallSummary` carries no agent id of its own; resolve it through `releaseId` first (the
  // fixture, like most installs, never sets `agentId` directly — brief §4 API gap), falling
  // back to `agentId` when an install does set it.
  const agentNameOf = useMemo(() => {
    const names = new Map(agents.map((agent) => [agent.id, agent.config?.name ?? agent.id]));
    const releaseAgent =
      releaseAgentMapState.status === 'ready' ? releaseAgentMapState.data : new Map();
    return (call: { agentId?: string; releaseId?: string }) => {
      const agentId =
        call.agentId ?? (call.releaseId ? releaseAgent.get(call.releaseId) : undefined);
      return agentId ? (names.get(agentId) ?? agentId) : 'Unattributed';
    };
  }, [agents, releaseAgentMapState]);

  const anyLoading =
    callsState.status === 'loading' ||
    (isEditorUp && (complaintsState.status === 'loading' || ratiosState.status === 'loading')) ||
    (isAdmin && (budgetsState.status === 'loading' || credentialsState.status === 'loading')) ||
    readinessState.status === 'loading' ||
    releaseAgentMapState.status === 'loading' ||
    callbacksState.status === 'loading';

  // Sources the attention list could not check: an empty list is only reassuring when every
  // source it reads actually answered.
  const unchecked = [
    callbacksState.status === 'error' && 'callbacks',
    agentsState.status === 'error' && 'agents',
    isEditorUp && complaintsState.status === 'error' && 'complaints',
    isEditorUp && ratiosState.status === 'error' && 'caller-number ratios',
    isAdmin && budgetsState.status === 'error' && 'budgets',
    isAdmin && credentialsState.status === 'error' && 'credentials',
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Overview"
        title="Home"
        description="Whether voice agents are healthy, cheap and compliant right now."
        meta={
          <div className="ds-range-picker" role="radiogroup" aria-label="Date range">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={rangeDays === option.value}
                className={rangeDays === option.value ? 'selected' : ''}
                onClick={() => setRangeDays(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        onRefresh={() => {
          void callsState.refresh();
          void agentsState.refresh();
          void performanceState.refresh();
          void infrastructureState.refresh();
        }}
      />

      <HomeKpiSection
        callsState={callsState}
        performanceState={performanceState}
        infrastructureState={infrastructureState}
        rangeDays={rangeDays}
      />

      <HomeCallsChartSection
        callsState={callsState}
        rangeDays={rangeDays}
        agentNameOf={agentNameOf}
      />

      <HomeSecondarySection callsState={callsState} infrastructureState={infrastructureState} />

      <HomeAttentionSection
        loading={anyLoading}
        agents={agents}
        readiness={readinessState.status === 'ready' ? readinessState.data : new Map()}
        budgets={isAdmin && budgetsState.status === 'ready' ? budgetsState.data : []}
        complaints={isEditorUp && complaintsState.status === 'ready' ? complaintsState.data : []}
        ratios={isEditorUp && ratiosState.status === 'ready' ? ratiosState.data : []}
        callbacks={callbacksState.status === 'ready' ? callbacksState.data : []}
        credentials={isAdmin && credentialsState.status === 'ready' ? credentialsState.data : []}
        recentCalls={recentCalls}
        recentCallsError={callsState.status === 'error' ? callsState.error : undefined}
        unchecked={unchecked}
        agentNameOf={agentNameOf}
      />
    </div>
  );
}
