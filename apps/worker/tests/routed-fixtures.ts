import { AgentConfig, MULAW_8K, type EndReason } from '@winsendotai/ovo-contracts';
import type { LoadedDistribution } from '@winsendotai/ovo-distribution';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { compose, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { vi } from 'vitest';
import { RoutedVoiceSessionFactory } from '../src/routed-session-factory.ts';
import { fakeMediaLink } from './segment-fixtures.ts';
import {
  fixturePlugins,
  type FixtureEngine,
  type FixtureRouter,
} from './routed-plugin-fixtures.ts';

export {
  fixturePlugins,
  type FixtureEngine,
  type FixtureRouter,
} from './routed-plugin-fixtures.ts';

/** An agent release on the fixture engine; `context` mode needs the fixture LLM. */
export function fixtureRelease(
  id: string,
  agentId: string,
  overrides: Partial<{
    mode: 'announcement' | 'context';
    maxCallSeconds: number;
    variables: Record<string, unknown>;
  }> = {},
): ReleaseRecord {
  const mode = overrides.mode ?? 'announcement';
  return {
    id,
    workspaceId: 'workspace-1',
    agentId,
    config: AgentConfig.parse({
      name: agentId,
      mode,
      ...(mode === 'announcement' ? { message: 'Hello.' } : {}),
      recording: false,
      ...(overrides.variables ? { variables: overrides.variables } : {}),
      ...(overrides.maxCallSeconds
        ? {
            costPolicy: {
              budgetId: 'budget-1',
              reservationPaise: '100',
              maxCallSeconds: overrides.maxCallSeconds,
              priceCards: { fixture: { id: 'card-1', version: '1' } },
            },
          }
        : {}),
    }),
    plugins: [],
    providerBindings: {},
    mcpTools: {},
    selections: {
      // The fixture engine reads which release it runs from its row.
      engine: { pluginId: 'fixture-engine', version: '1.0.0', config: { release: id } },
      ...(mode === 'context'
        ? { llm: { pluginId: 'fixture-llm', version: '1.0.0', config: {} } }
        : {}),
    },
    draftVersion: 1,
    createdAt: '2026-10-15T00:00:00.000Z',
    createdBy: 'operator-1',
  } as unknown as ReleaseRecord;
}

/** A routed call on a fake media link, through the routed factory with every port faked. */
export async function routedCall(input: {
  releases: ReleaseRecord[];
  routerReleaseId: string;
  routing?: Record<string, unknown>;
  getRouting?: () => Promise<unknown>;
  routerBehavior?: () => PluginDefinition;
  transcriptOmitted?: string[];
}) {
  const engines: FixtureEngine[] = [];
  const routers: FixtureRouter[] = [];
  const plugins = fixturePlugins(engines, routers);
  const parent = await compose([], []);
  const link = Object.assign(fakeMediaLink(), {
    format: MULAW_8K,
    onAnsweredBy: () => () => undefined,
  });
  const outcomes = new MemoryCallOutcomeStore();
  const audits: [string, Record<string, unknown>][] = [];
  const telemetry = {
    audit: (type: string, payload: Record<string, unknown>) => audits.push([type, payload]),
    providerUsage: vi.fn(),
    engineEvent: vi.fn(),
    adapter: { speech: vi.fn(), timing: vi.fn() },
    withOperationStore: (store: unknown) => store,
    close: vi.fn(async () => undefined),
  };
  const createSession = vi.fn(async (_input: Record<string, unknown>) => telemetry);
  const omitted = new Set(input.transcriptOmitted ?? []);
  const createCall = vi.fn(async (call: { id: string; releaseId: string }) => ({
    ...call,
    kind: 'live',
  }));
  const beforeClose = vi.fn(
    async (_job: DurableJob, _route: SessionRoute, _reason: EndReason) => undefined,
  );
  const claims = { claim: vi.fn(), release: vi.fn(async () => 1) };
  const getRouting = vi.fn(input.getRouting ?? (async () => undefined));
  const factory = new RoutedVoiceSessionFactory(
    {
      getRelease: async (_workspace: string, id: string) => input.releases.find((r) => r.id === id),
      getCall: async () => undefined,
      createCall,
      operationStore: {},
    } as never,
    { forAgent: () => ({ resolve: vi.fn(async () => 'secret') }) } as never,
    {
      createSession,
      strictestTranscriptText: (agentIds: readonly string[]) =>
        agentIds.some((id) => omitted.has(id)) ? 'omit' : 'store',
    } as never,
    undefined,
    undefined,
    { plugins: [], nativeHandlers: {} },
    undefined,
    30,
    undefined,
    {
      distribution: {
        catalog: [plugins.llm, plugins.engine],
        defaults: { engine: 'fixture-engine' },
      } as unknown as LoadedDistribution,
      parent,
      outcomes,
      carriers: {
        forJob: async () => ({
          carrier: {
            carrierId: 'fixture',
            capabilities: {
              media: {
                formats: [MULAW_8K],
                playbackEvidence: 'carrier-played',
                clearFlushesMarkers: true,
              },
            },
          },
        }),
      } as never,
    },
    beforeClose,
  ).route({
    routing: { releases: { get: getRouting } as never, claims: claims as never },
    routerBehavior: input.routerBehavior ?? (() => plugins.router),
    externalEnabled: false,
    snapshotTimeoutMs: 50,
  });
  const job = {
    id: 'job-1',
    workspaceId: 'workspace-1',
    payload: {
      kind: 'inbound_call',
      releaseId: input.routerReleaseId,
      callId: 'call-1',
      from: '+919800000001',
      to: '+918000000002',
      variables: { customer: 'Asha' },
      ...(input.routing ? { routing: input.routing } : {}),
    },
  } as unknown as DurableJob;
  const route = { sessionId: 'session-1', jobId: 'job-1', carrierId: 'fixture' } as SessionRoute;
  const events = async () =>
    (await outcomes.listEvents('workspace-1', 'call-1')).items.map((event) => [
      event.type,
      event.payload,
    ]);
  return {
    ...{
      factory,
      job,
      route,
      link,
      engines,
      routers,
      audits,
      telemetry,
      createSession,
      createCall,
    },
    ...{ beforeClose, claims, getRouting, events, parent },
    open: () => factory.create({ job, route, media: link as never }),
  };
}
