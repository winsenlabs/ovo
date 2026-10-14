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
import { callsWithin, dailyCallBuckets, type CallRow } from '../derive/calls';
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

async function loadOne(
  agent: AgentSummaryRow,
  plugins: readonly PluginCatalog['plugins'][number][],
  calls: readonly CallRow[],
): Promise<AgentOverviewRow> {
  const [readinessResult, releasesResult] = await Promise.allSettled([
    apiRequest<AgentReadiness>(`/agents/${encodeURIComponent(agent.id)}/readiness`),
    apiRequest<unknown>(`/agents/${encodeURIComponent(agent.id)}/releases`),
  ]);
  const releases =
    releasesResult.status === 'fulfilled' ? items<Release>(releasesResult.value.data) : [];
  const agentCalls = calls.filter((call) => call.agentId === agent.id);
  const last7d = callsWithin(agentCalls, 7 * 86_400_000);
  return {
    id: agent.id,
    name: agent.config.name || agent.id,
    mode: agent.config.mode,
    updatedAt: agent.updatedAt,
    readiness: readinessResult.status === 'fulfilled' ? readinessResult.value.data : undefined,
    readinessError: readinessResult.status === 'rejected' ? 'Readiness unavailable' : undefined,
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
      const rows = await Promise.all(agents.map((agent) => loadOne(agent, plugins, calls)));
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
