'use client';
// Everything the agent Overview tab shows, derived client-side from four endpoints the way the
// brief's Home spec asks for Overview (brief §3 "Agent detail / studio" > Overview): calls
// filtered to this agent, this agent's latency cohort, its releases and its required meters.
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items, type AgentReadiness, type Release } from '../api';
import type { PerformanceGroupResult, PerformanceResult } from '@winsendotai/ovo-contracts';
import {
  callsWithin,
  completionRate,
  dispositionBreakdown,
  failureCount,
  timeoutShareOfFailures,
  type CallRow,
  type DispositionSlice,
} from '../derive/calls';
import { pickFirstAudioStage } from '../derive/performance';

export type RequiredMeterChecklist = {
  draftVersion: number;
  complete: boolean;
  provisional: boolean;
  meters: { key: string; label: string; status: string }[];
};

export type AgentOverviewData = {
  calls7d: number;
  completionRate: number | null;
  failures: number;
  timeoutShare: number | null;
  firstAudioP95Ms: number | null;
  firstAudioStageLabel: string | null;
  dispositions: DispositionSlice[];
  releases: Release[];
  latestRelease?: Release;
  releaseCount: number;
  readiness?: AgentReadiness;
  readinessError?: string;
  requiredMeters?: RequiredMeterChecklist;
  requiredMetersError?: string;
};

export type AgentOverviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AgentOverviewData };

export function useAgentOverview(agentId: string): AgentOverviewState & { reload: () => void } {
  const [state, setState] = useState<AgentOverviewState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const [callsResult, performanceResult, releasesResult, readinessResult, metersResult] =
        await Promise.allSettled([
          apiRequest<unknown>(
            `/calls?agentId=${encodeURIComponent(agentId)}&limit=200&order=desc`,
          ),
          apiRequest<PerformanceResult>(
            `/performance?agentId=${encodeURIComponent(agentId)}&from=${from.toISOString()}&to=${now.toISOString()}&bucket=hour&groupBy=stage&maxGroups=50`,
          ),
          apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`),
          apiRequest<AgentReadiness>(`/agents/${encodeURIComponent(agentId)}/readiness`),
          apiRequest<RequiredMeterChecklist>(
            `/agents/${encodeURIComponent(agentId)}/required-meters`,
          ),
        ]);
      if (callsResult.status === 'rejected') throw callsResult.reason;
      // `/calls?agentId=` has no date filter, so the 7-day window is cut client-side from the
      // 200 newest calls — an honest approximation that may undercount a very high-volume agent
      // rather than one that silently fetches an unbounded history.
      const calls = callsWithin(items<CallRow>(callsResult.value.data), 7 * 86_400_000);
      const releases =
        releasesResult.status === 'fulfilled' ? items<Release>(releasesResult.value.data) : [];
      const stageGroups: readonly PerformanceGroupResult[] =
        performanceResult.status === 'fulfilled' ? performanceResult.value.data.groups : [];
      const firstAudio = pickFirstAudioStage(stageGroups);
      setState({
        status: 'ready',
        data: {
          calls7d: calls.length,
          completionRate: completionRate(calls),
          failures: failureCount(calls),
          timeoutShare: timeoutShareOfFailures(calls),
          firstAudioP95Ms: firstAudio?.p95Ms ?? null,
          firstAudioStageLabel: firstAudio?.cohort.stage ?? null,
          dispositions: dispositionBreakdown(calls),
          releases,
          // Newest first, as the API lists them (confirmed against the fixture).
          latestRelease: releases[0],
          releaseCount: releases.length,
          readiness: readinessResult.status === 'fulfilled' ? readinessResult.value.data : undefined,
          readinessError: readinessResult.status === 'rejected' ? 'Readiness unavailable' : undefined,
          requiredMeters: metersResult.status === 'fulfilled' ? metersResult.value.data : undefined,
          requiredMetersError:
            metersResult.status === 'rejected' ? 'Required meters unavailable' : undefined,
        },
      });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'This agent is unavailable',
      });
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load, generation]);
  return { ...state, reload: () => setGeneration((value) => value + 1) };
}
