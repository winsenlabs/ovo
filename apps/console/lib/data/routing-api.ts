import { apiRequest, ApiError, items } from '../api';
import { json } from './json-init';
import type {
  ActivityWindow,
  AgentOption,
  AudioRecord,
  NumberRow,
  PointRecord,
  PoolRecord,
  PoolUtilisation,
  QueueActivity,
  PublishPreview,
  ReleaseSummary,
  RoutingIssue,
  RoutingPointDraft,
  RoutingPool,
  RoutingRelease,
  RoutingStats,
  RoutingStatus,
  StatsWindow,
} from '../types/routing';
import type {
  PoolExplainRequest,
  PoolExplanation,
  RoutingSimulationResult,
  SimulationRequest,
} from '../types/routing-simulate';
import type { PoolDefinition } from '../derive/routing-pools';

const enc = encodeURIComponent;
const versionOf = (etag: string | undefined, fallback: number) =>
  Number(etag?.replaceAll('"', '')) || fallback;

/** Every page of a list route, following `nextCursor` (bounded so a stuck cursor cannot loop). */
async function pages<T>(path: string, limit = 100): Promise<T[]> {
  const found: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const { data } = await apiRequest<unknown>(`${path}${path.includes('?') ? '&' : '?'}${query}`);
    found.push(...items<T>(data));
    const next = (data as { nextCursor?: string | null } | null)?.nextCursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return found;
}

/** The `/v1/routing/*` administration calls, plus the neighbours the designer reads. */
export const routingApi = {
  status: async () => (await apiRequest<RoutingStatus>('/routing/status')).data,
  stats: async (window: StatsWindow) =>
    (await apiRequest<RoutingStats>(`/routing/stats?window=${window}`)).data,

  points: () => pages<PointRecord>('/routing/points?include=summary'),
  point: async (id: string) => {
    const { data, etag } = await apiRequest<PointRecord>(`/routing/points/${enc(id)}`);
    return { point: data, version: versionOf(etag, data.draftVersion) };
  },
  createPoint: async (draft: RoutingPointDraft) =>
    (await apiRequest<PointRecord>('/routing/points', json('POST', { draft }))).data,
  savePoint: async (id: string, draft: RoutingPointDraft, version: number) =>
    (await apiRequest<PointRecord>(`/routing/points/${enc(id)}`, json('PUT', { draft }, version)))
      .data,
  removePoint: async (id: string, version: number) =>
    void (await apiRequest(`/routing/points/${enc(id)}`, json('DELETE', undefined, version))),
  validate: async (id: string, draft: RoutingPointDraft) =>
    (
      await apiRequest<{ issues: RoutingIssue[] }>(
        `/routing/points/${enc(id)}/validate`,
        json('POST', { draft }),
      )
    ).data.issues,
  previewPublish: async (id: string, draft?: RoutingPointDraft) =>
    (
      await apiRequest<PublishPreview>(
        `/routing/points/${enc(id)}/preview-publish`,
        json('POST', draft ? { draft } : {}),
      )
    ).data,
  publish: async (id: string, expectedDraftVersion: number) =>
    (
      await apiRequest<RoutingRelease & { warnings?: RoutingIssue[] }>(
        `/routing/points/${enc(id)}/releases`,
        json('POST', { expectedDraftVersion }),
      )
    ).data,
  releases: (id: string) =>
    pages<ReleaseSummary>(`/routing/points/${enc(id)}/releases?view=summary`),
  release: async (id: string) =>
    (await apiRequest<RoutingRelease>(`/routing/releases/${enc(id)}`)).data,

  pools: () => pages<PoolRecord>('/routing/pools'),
  pool: async (id: string) => {
    const { data, etag } = await apiRequest<PoolRecord>(`/routing/pools/${enc(id)}`);
    return { pool: data, version: versionOf(etag, data.version) };
  },
  createPool: async (definition: PoolDefinition) =>
    (await apiRequest<RoutingPool>('/routing/pools', json('POST', { definition }))).data,
  savePool: async (id: string, definition: PoolDefinition, version: number) =>
    (
      await apiRequest<RoutingPool>(
        `/routing/pools/${enc(id)}`,
        json('PUT', { definition }, version),
      )
    ).data,
  removePool: async (id: string, version: number) =>
    void (await apiRequest(`/routing/pools/${enc(id)}`, json('DELETE', undefined, version))),
  /** Every pool's totals in one call (the answer is a list under `items` or `pools`). */
  utilisationAll: async (): Promise<PoolUtilisation[]> => {
    const { data } = await apiRequest<unknown>('/routing/utilisation');
    const pools = (data as { pools?: PoolUtilisation[] } | null)?.pools;
    return Array.isArray(pools) ? pools : items<PoolUtilisation>(data);
  },
  utilisation: async (poolId: string) =>
    (await apiRequest<PoolUtilisation>(`/routing/pools/${enc(poolId)}/utilisation`)).data,
  explain: async (body: PoolExplainRequest) =>
    (await apiRequest<PoolExplanation>('/routing/pools/explain', json('POST', body))).data,

  audio: () => pages<AudioRecord>('/routing/audio'),
  audioOne: async (id: string) => (await apiRequest<AudioRecord>(`/routing/audio/${enc(id)}`)).data,
  uploadAudio: async (name: string, file: Blob) =>
    (
      await apiRequest<AudioRecord>(`/routing/audio?name=${enc(name)}`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'audio/wav' },
      })
    ).data,
  /** The clip as a blob, for a preview played from a blob URL (the bytes never go through JSON). */
  audioBlob: async (id: string) => {
    const response = await fetch(`/api/v1/routing/audio/${enc(id)}/content`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new ApiError(response.status, 'audio_unavailable', 'Clip unavailable');
    return response.blob();
  },
  removeAudio: async (id: string) =>
    void (await apiRequest(`/routing/audio/${enc(id)}`, json('DELETE'))),

  simulate: async (body: SimulationRequest) =>
    (await apiRequest<RoutingSimulationResult>('/routing/simulate', json('POST', body))).data,

  /** Agents for the router, default and member pickers. */
  agents: async (): Promise<AgentOption[]> =>
    (await pages<Record<string, unknown>>('/agents')).map((row) => ({
      id: String(row.id ?? row.agentId),
      name: String((row.config as { name?: unknown } | undefined)?.name ?? row.name ?? row.id),
    })),
  agentReleases: (agentId: string) =>
    pages<{ id: string; version?: number; createdAt?: string }>(`/agents/${enc(agentId)}/releases`),
  queueActivity: async (queueId: string, window: ActivityWindow) =>
    (
      await apiRequest<QueueActivity>(
        `/human-queues/${enc(queueId)}/activity?window=${window}`,
      )
    ).data,
  numbers: () => pages<NumberRow>('/operations/inbound/routes'),
  bindNumber: async (
    row: NumberRow,
    target: { routingReleaseId: string } | { releaseId: string },
  ) =>
    (
      await apiRequest<NumberRow>(
        `/operations/inbound/routes/${enc(row.phoneNumber)}`,
        json('PUT', {
          expectedVersion: row.version,
          ...target,
          variables: row.variables,
          enabled: row.enabled,
          carrierPluginId: row.carrierPluginId,
          carrierBindingId: row.carrierBindingId,
        }),
      )
    ).data,
};

/** True when the feature is switched off on this installation (`routing_disabled`). */
export function isRoutingDisabled(failure: unknown): boolean {
  return (
    failure instanceof ApiError &&
    (failure.code === 'routing_disabled' || failure.code === 'human_queue_disabled')
  );
}
