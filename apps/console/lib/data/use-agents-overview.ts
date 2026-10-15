'use client';
// Everything the Agents list needs, relogic'd from four cheap endpoints instead of the one bare
// `/agents` page the old list rendered (brief §3 Agents list). The fixture's agent count is small
// enough that loading every agent (not just one page) gives honest KPI totals instead of
// "this page only" numbers that would silently change as an operator pages through.
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items, normalizeDraft, type AgentConfig } from '../api';
import { loadAgents } from '../pagination';
import type { AgentReadiness, Release } from '../api';
import type { PluginCatalog } from '../../components/plugins/types';
import { callsWithin, dailyCallBuckets, type CallRow } from '../derive/agent-calls';
import { voiceStackChips, type VoiceStackChip } from '../derive/agents';

export type AgentSummaryRow = {
  id: string;
  config: AgentConfig;
  draftVersion?: string;
  updatedAt?: string;
};

/** `/agents` sometimes returns bare `{id}` references rather than the inline config (the same
 * split `useAgentStudio` used to handle); hydrate whichever rows are missing one. */
async function hydrate(raw: readonly Record<string, unknown>[]): Promise<AgentSummaryRow[]> {
  const bare = raw.filter((row) => !row.config);
  if (!bare.length) return raw.map((row) => normalizeDraft(row));
  const detailed = await Promise.all(
    bare.map(async (row) => {
      const id = String(row.id ?? row.agentId);
      const result = await apiRequest<unknown>(`/agents/${encodeURIComponent(id)}`);
      return normalizeDraft(result.data, result.etag);
    }),
  );
  const byId = new Map(detailed.map((draft) => [draft.id, draft]));
  return raw.map((row) => (row.config ? normalizeDraft(row) : byId.get(String(row.id))!));
}

export type AgentOverviewRow = {
  id: string;
  name: string;
  mode: AgentConfig['mode'];
  updatedAt?: string;
  readiness?: AgentReadiness;
  readinessError?: string;
  latestRelease?: Release;
  releaseCount: number;
  voiceStack: VoiceStackChip[];
  language: string;
  calls7d: number;
  callsSparkline: number[];
};

export type AgentsOverviewTotals = {
  agents: number;
  withRelease: number;
  blocked: number;
  calls24h: number;
};

export type AgentsOverviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: AgentOverviewRow[]; totals: AgentsOverviewTotals };

async function loadReleases(agentId: string): Promise<Release[]> {
  const result = await apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`);
  return items<Release>(result.data);
}

function buildOne(
  agent: AgentSummaryRow,
  releases: readonly Release[],
  readiness: AgentReadiness | undefined,
  readinessError: string | undefined,
  plugins: readonly PluginCatalog['plugins'][number][],
  calls: readonly CallRow[],
  releaseIds: ReadonlySet<string>,
): AgentOverviewRow {
  // A call record from the bulk `/calls` listing carries `releaseId`, not `agentId` (only the
  // agent-scoped `/calls?agentId=` endpoint, which the Overview tab uses, resolves that server
  // side). Resolving the release back to its own agent — via this agent's own immutable
  // releases, already fetched below — is what the brief asks for instead of a `calls7d` that
  // reads 0 for every row while the Overview tab for the same agent shows real traffic.
  const agentCalls = calls.filter(
    (call) =>
      call.agentId === agent.id || (call.releaseId != null && releaseIds.has(call.releaseId)),
  );
  const last7d = callsWithin(agentCalls, 7 * 86_400_000);
  return {
    id: agent.id,
    name: agent.config.name || agent.id,
    mode: agent.config.mode,
    updatedAt: agent.updatedAt,
    readiness,
    readinessError,
    // Newest first, as the API lists them (confirmed against the fixture).
    latestRelease: releases[0],
    releaseCount: releases.length,
    voiceStack: voiceStackChips(agent.config.voice, plugins),
    language: agent.config.language || 'Unknown',
    calls7d: last7d.length,
    callsSparkline: dailyCallBuckets(agentCalls, 7).map((bucket) => bucket.count),
  };
}

export function useAgentsOverview(): AgentsOverviewState & { reload: () => void } {
  const [state, setState] = useState<AgentsOverviewState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [rawAgents, pluginsResult, callsResult] = await Promise.all([
        loadAgents<Record<string, unknown>>(),
        apiRequest<PluginCatalog>('/plugins').catch(() => ({ data: { plugins: [] } })),
        apiRequest<unknown>('/calls?limit=300&order=desc').catch(() => ({ data: { items: [] } })),
      ]);
      const agents = await hydrate(rawAgents);
      const plugins = pluginsResult.data.plugins;
      const calls = items<CallRow>(callsResult.data);
      const perAgent = await Promise.all(
        agents.map(async (agent) => {
          const [releasesResult, readinessResult] = await Promise.allSettled([
            loadReleases(agent.id),
            apiRequest<AgentReadiness>(`/agents/${encodeURIComponent(agent.id)}/readiness`),
          ]);
          return {
            agent,
            releases: releasesResult.status === 'fulfilled' ? releasesResult.value : [],
            readiness:
              readinessResult.status === 'fulfilled' ? readinessResult.value.data : undefined,
            readinessError:
              readinessResult.status === 'rejected' ? 'Readiness unavailable' : undefined,
          };
        }),
      );
      const rows = perAgent.map(({ agent, releases, readiness, readinessError }) =>
        buildOne(
          agent,
          releases,
          readiness,
          readinessError,
          plugins,
          calls,
          new Set(releases.map((release) => release.id)),
        ),
      );
      const totals: AgentsOverviewTotals = {
        agents: rows.length,
        withRelease: rows.filter((row) => row.releaseCount > 0).length,
        blocked: rows.filter((row) => row.readiness?.releaseReady === false).length,
        calls24h: callsWithin(calls, 24 * 60 * 60 * 1000).length,
      };
      setState({ status: 'ready', rows, totals });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Agents are unavailable',
      });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, generation]);
  return { ...state, reload: () => setGeneration((value) => value + 1) };
}
