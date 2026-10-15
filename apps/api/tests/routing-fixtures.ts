import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentConfig, Cap, type CredentialMetadata } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { registerRoutingRoutes } from '../src/routes/routing.ts';
import { FakeRoutingService } from './routing-fake-service.ts';
import type { RoutingRouteDependencies } from '../src/routes/routing-support.ts';

export const WORKSPACE = 'ws-routing';
export const POOL_SALES = '11111111-1111-4111-8111-111111111111';
export const POOL_SUPPORT = '22222222-2222-4222-8222-222222222222';
export const ROUTER_RELEASE = '44444444-4444-4444-8444-444444444444';
export const DEFAULT_RELEASE = '55555555-5555-4555-8555-555555555555';
export const SALES_EN_RELEASE = '66666666-6666-4666-8666-666666666666';
export const SALES_HI_RELEASE = '77777777-7777-4777-8777-777777777777';
export const SUPPORT_RELEASE = '88888888-8888-4888-8888-888888888888';

/** The design's worked example (section 20), cut to two pools: a valid draft input. */
export function draftInput(): Record<string, any> {
  return {
    name: 'Main line',
    router: { agentId: 'front-desk', release: { kind: 'latest' } },
    defaultTarget: { agentId: 'sales-en', release: { kind: 'latest' } },
    language: { default: 'en', allowed: ['en', 'hi'] },
    greeting: { en: 'Welcome to Acme. How can I help you today?', hi: 'Acme में आपका स्वागत है।' },
    root: 'intent',
    nodes: [
      {
        id: 'intent',
        sets: 'intent',
        ask: { en: 'Are you calling to buy something, or about an existing account?' },
        engines: [
          { kind: 'rules', rules: [{ branch: 'sales', when: [{ kind: 'dtmf', digits: '1' }] }] },
          { kind: 'llm', instructions: 'Decide why the caller is calling.' },
        ],
        branches: [
          {
            key: 'sales',
            description: 'Wants to buy something new',
            target: { kind: 'pool', poolId: POOL_SALES, language: 'caller' },
          },
          {
            key: 'support',
            description: 'Has a problem with an existing account',
            target: { kind: 'pool', poolId: POOL_SUPPORT, language: 'any' },
          },
        ],
        fallback: [
          { kind: 'reask', times: 1 },
          { kind: 'default' },
          { kind: 'end', line: { en: 'Sorry, I could not connect your call. Goodbye.' } },
        ],
      },
    ],
  };
}

export function poolInput(name: string, members: [string, string[]][]): Record<string, any> {
  return {
    name,
    members: members.map(([agentId, languages]) => ({
      id: agentId,
      agent: { agentId, release: { kind: 'latest' } },
      languages,
    })),
  };
}

// 'infra' keeps the manifests minimal; the meter checklist reads only meters and provider.
const meterPlugin = (id: string, role: string, keys: string[]) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'infra',
      provider: id,
      provides: [Cap.inference],
      requires: [],
      meters: keys.map((key) => ({ key, unit: 'audio_seconds', role, label: key })),
    } as never,
    () => undefined,
  );
export const registry = new PluginRegistry([
  meterPlugin('stt-a', 'stt', ['stt-a.seconds']),
  meterPlugin('stt-b', 'stt', ['stt-b.seconds']),
  meterPlugin('llm-a', 'llm', ['llm-a.seconds']),
]);
const pick = (pluginId: string) => ({ pluginId, version: '1.0.0', config: {} });

/** A published agent release; the router-shaped default selects STT and an LLM. */
export function release(
  id: string,
  agentId: string,
  patch: { config?: Record<string, unknown>; selections?: Record<string, unknown> } = {},
): ReleaseRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    agentId,
    draftVersion: 1,
    config: {
      ...AgentConfig.parse({ name: agentId, mode: 'agent' }),
      ...patch.config,
    } as AgentConfig,
    plugins: [],
    selections: (patch.selections ?? { stt: pick('stt-a'), llm: pick('llm-a') }) as never,
    providerBindings: {},
    mcpTools: {},
    createdAt: '2026-10-15T00:00:00.000Z',
    createdBy: 'test',
  };
}

export const costPolicy = (priced: string[]) => ({
  budgetId: 'budget',
  reservationPaise: '100',
  maxCallSeconds: 600,
  priceCards: Object.fromEntries(priced.map((key) => [key, { id: key, version: 'v1' }])),
});

/** Every release the worked example names, by agent, oldest first. */
export function exampleReleases(): ReleaseRecord[] {
  return [
    release(ROUTER_RELEASE, 'front-desk'),
    release(DEFAULT_RELEASE, 'sales-en'),
    release(SALES_HI_RELEASE, 'sales-hi'),
    release(SUPPORT_RELEASE, 'support'),
  ];
}

/** The control store calls routing makes, over a fixed set of releases and credentials. */
export function fakeStore(
  releases: ReleaseRecord[],
  credentials: Partial<CredentialMetadata>[] = [],
) {
  const audits: Record<string, unknown>[] = [];
  return {
    audits,
    releases,
    async getRelease(workspaceId: string, id: string) {
      return releases.find((item) => item.workspaceId === workspaceId && item.id === id);
    },
    async listReleases(workspaceId: string, agentId: string) {
      const items = releases.filter((r) => r.workspaceId === workspaceId && r.agentId === agentId);
      return { items, nextCursor: null };
    },
    async getCredential(_workspaceId: string, id: string) {
      const found = credentials.find((item) => item.id === id);
      return found
        ? ({ status: 'active', expiresAt: null, permittedAgentIds: [], ...found } as never)
        : undefined;
    },
    async audit(entry: Record<string, unknown>) {
      audits.push(entry);
    },
  };
}

const RANK = { viewer: 0, editor: 1, admin: 2 } as const;

/** A Fastify app with only the routing routes, a role from `x-role`, and the API's error shapes. */
export function routingApp(
  options: Partial<RoutingRouteDependencies> & {
    releases?: ReleaseRecord[];
    credentials?: Partial<CredentialMetadata>[];
  } = {},
) {
  const app = Fastify({ logger: false });
  const routing = new FakeRoutingService();
  const store = fakeStore(options.releases ?? exampleReleases(), options.credentials);
  app.setErrorHandler((caught, _request, reply) => {
    const thrown = caught as Error & { statusCode?: number; code?: string };
    if (thrown instanceof z.ZodError)
      return reply.code(400).send({ error: { code: 'validation_error', issues: thrown.issues } });
    return reply
      .code(thrown.statusCode ?? 500)
      .send({ error: { code: thrown.code ?? 'internal_error', message: thrown.message } });
  });
  registerRoutingRoutes({
    app,
    store: store as never,
    requireRole: (request: FastifyRequest, role) => {
      const held = (request.headers['x-role'] ?? 'admin') as keyof typeof RANK;
      if (RANK[held] < RANK[role as keyof typeof RANK])
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'forbidden' });
      return { identityId: 'operator', label: 'Operator', workspaceId: WORKSPACE, role: held };
    },
    operations: { organizationId: WORKSPACE, routing } as never,
    enabled: true,
    externalEnabled: false,
    requireCostPolicy: false,
    registry,
    expectedVersion: (request) => {
      const value = request.headers['if-match'];
      if (typeof value !== 'string')
        throw Object.assign(new Error('If-Match is required'), {
          statusCode: 428,
          code: 'precondition_required',
        });
      return Number(value.replaceAll('"', ''));
    },
    ...options,
  });
  return { app, routing, store };
}

export { FakeRoutingService };
