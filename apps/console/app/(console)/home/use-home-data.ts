'use client';
import { useCallback } from 'react';
import { apiRequest, type AgentReadiness } from '../../../lib/api';
import { useResource } from '../../../lib/data/use-resource';
import type {
  HomeAgent,
  HomeCall,
  HomeCallback,
  HomeComplaint,
  HomeCredential,
  HomeRatio,
} from './types';
import type { BudgetSnapshot, PerformanceResult } from '../../../lib/types/operations';
import type { InfrastructureSnapshot } from '@winsendotai/ovo-contracts';

const DAY_MS = 86_400_000;
const CALL_PAGE_LIMIT = 200;
const CALL_CAP = 1000;

/** Pages `/calls?order=desc` until a row is older than `rangeDays` ago or the 1000-row cap is
 * hit (brief §3 Home "Data"). One independent resource so a 503 here never blocks the rest of
 * the dashboard. */
export function useHomeCalls(rangeDays: number) {
  const load = useCallback(async () => {
    const cutoff = Date.now() - rangeDays * DAY_MS;
    const collected: HomeCall[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < Math.ceil(CALL_CAP / CALL_PAGE_LIMIT); page++) {
      const params = new URLSearchParams({ limit: String(CALL_PAGE_LIMIT), order: 'desc' });
      if (cursor) params.set('cursor', cursor);
      const { data } = await apiRequest<{ items: HomeCall[]; nextCursor?: string | null }>(
        `/calls?${params}`,
      );
      collected.push(...data.items);
      const oldest = data.items.at(-1);
      if (!data.nextCursor || !oldest || Date.parse(oldest.createdAt ?? '') < cutoff) break;
      cursor = data.nextCursor;
      if (collected.length >= CALL_CAP) break;
    }
    return collected
      .filter((call) => Date.parse(call.createdAt ?? '') >= cutoff)
      .slice(0, CALL_CAP);
  }, [rangeDays]);
  return useResource(`home-calls-${rangeDays}`, load, 30_000);
}

export function useHomeAgents() {
  const load = useCallback(async () => {
    const { data } = await apiRequest<{ items: HomeAgent[] }>('/agents?limit=50');
    return data.items;
  }, []);
  return useResource('home-agents', load, 60_000);
}

export function useHomePerformance() {
  const load = useCallback(async () => {
    const to = new Date();
    const from = new Date(to.getTime() - DAY_MS);
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: 'hour',
      groupBy: 'time,stage',
      maxGroups: '200',
    });
    const { data } = await apiRequest<PerformanceResult>(`/performance?${params}`);
    return data;
  }, []);
  return useResource('home-performance-24h', load, 60_000);
}

export function useHomeInfrastructure() {
  const load = useCallback(async () => {
    const { data } = await apiRequest<InfrastructureSnapshot>('/infrastructure');
    return data;
  }, []);
  return useResource('home-infrastructure', load, 20_000);
}

export function useHomeCallbacks() {
  const load = useCallback(async () => {
    const { data } = await apiRequest<{ items: HomeCallback[] }>(
      '/callbacks?status=pending&limit=50',
    );
    return data.items;
  }, []);
  return useResource('home-callbacks-pending', load, 30_000);
}

/** Admin/editor-gated resources short-circuit to an empty list instead of firing a request a
 * viewer would get a 403 for — the card itself is simply left out of the grid for that role
 * (brief §3 Home "States": "Viewer/editor see admin-only cards replaced by nothing"). */
export function useHomeComplaints(enabled: boolean) {
  const load = useCallback(async () => {
    if (!enabled) return [];
    const { data } = await apiRequest<{ items: HomeComplaint[] }>(
      '/operations/compliance/complaints',
    );
    return data.items;
  }, [enabled]);
  return useResource(`home-complaints-${enabled}`, load, 60_000);
}

export function useHomeRatios(enabled: boolean) {
  const load = useCallback(async () => {
    if (!enabled) return [];
    const { data } = await apiRequest<{ items: HomeRatio[] }>('/operations/compliance/ratios');
    return data.items;
  }, [enabled]);
  return useResource(`home-ratios-${enabled}`, load, 60_000);
}

export function useHomeBudgets(enabled: boolean) {
  const load = useCallback(async () => {
    if (!enabled) return [];
    const { data } = await apiRequest<{ items: BudgetSnapshot[] }>('/cost/budgets');
    return data.items;
  }, [enabled]);
  return useResource(`home-budgets-${enabled}`, load, 60_000);
}

export function useHomeCredentials(enabled: boolean) {
  const load = useCallback(async () => {
    if (!enabled) return [];
    const { data } = await apiRequest<{ items: HomeCredential[] }>('/credentials');
    return data.items;
  }, [enabled]);
  return useResource(`home-credentials-${enabled}`, load, 60_000);
}

/** One `/agents/:id/readiness` per agent, capped at 20 — the fixture has 6, a real install's
 * "needs attention" list is a summary, not an audit, so a cap keeps this honest without an
 * N+1 fan-out on a large roster. */
export function useHomeReadiness(agentIds: readonly string[]) {
  const capped = agentIds.slice(0, 20);
  const load = useCallback(async () => {
    const entries = await Promise.all(
      capped.map(async (id) => {
        try {
          const { data } = await apiRequest<AgentReadiness>(
            `/agents/${encodeURIComponent(id)}/readiness`,
          );
          return [id, data] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    );
    return new Map(entries);
  }, [capped.join(',')]);
  return useResource(`home-readiness-${capped.join(',')}`, load, 60_000);
}

/** `CallSummary` carries no agent id (brief §4 "API gaps to respect" — "map `releaseId` → agent
 * through the agents' release lists"). One `/agents/:id/releases` per agent (same 20-agent cap
 * as readiness) builds that `releaseId -> agentId` map once; Home resolves every call's agent
 * name through it instead of leaving every row "Unattributed". */
export function useHomeReleaseAgentMap(agentIds: readonly string[]) {
  const capped = agentIds.slice(0, 20);
  const load = useCallback(async () => {
    const entries = await Promise.all(
      capped.map(async (agentId) => {
        try {
          const { data } = await apiRequest<{ items: { id: string }[] }>(
            `/agents/${encodeURIComponent(agentId)}/releases`,
          );
          return data.items.map((release) => [release.id, agentId] as const);
        } catch {
          return [];
        }
      }),
    );
    return new Map(entries.flat());
  }, [capped.join(',')]);
  return useResource(`home-release-agent-map-${capped.join(',')}`, load, 60_000);
}
