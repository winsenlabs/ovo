import { afterEach, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HumanQueueDefinition, HUMAN_METER_KEYS } from '@winsendotai/ovo-contracts';
import { InMemoryHumanQueueService } from '@winsendotai/ovo-plugin-operations/testing';
import {
  costPolicy,
  DEFAULT_RELEASE,
  draftInput,
  exampleReleases,
  FakeRoutingService,
  POOL_SALES,
  POOL_SUPPORT,
  poolInput,
  release,
  ROUTER_RELEASE,
  routingApp,
  WORKSPACE,
} from './routing-fixtures.ts';
import { RoutingPoolDefinition } from '@winsendotai/ovo-contracts';

const apps: FastifyInstance[] = [];
/** Closes the apps this file's tests built, after each test; call once at the top of a test file. */
export const closeAppsAfterEach = () =>
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

export const KEY = 'support-desk';
export const external = (patch: Record<string, unknown> = {}) => ({
  kind: 'external',
  name: `ACD ${Math.random()}`,
  webhook: { url: 'https://acd.example.com/h', credentialId: 'acd-hmac' },
  destination: { allowE164Prefixes: ['+9140'] },
  ...patch,
});
export const managed = (patch: Record<string, unknown> = {}) => ({
  kind: 'managed',
  name: `Desk ${Math.random()}`,
  ...patch,
});

export interface Options {
  humanQueueEnabled?: boolean;
  humanQueueWebhookEnabled?: boolean;
  roomConfigured?: boolean;
  transferEnabled?: boolean;
  /** Routers with a cost policy that prices the human meters. */
  priced?: boolean;
  routerCostPolicy?: ReturnType<typeof costPolicy>;
}

/** The routing routes over a fake routing service and the in-memory human queue service. */
export async function setup(options: Options = {}) {
  const queues = new InMemoryHumanQueueService({ organizationId: WORKSPACE });
  const routing = new FakeRoutingService();
  const releases = [
    ...exampleReleases().filter((item) => item.id !== ROUTER_RELEASE),
    release(ROUTER_RELEASE, 'front-desk'),
  ];
  if (options.routerCostPolicy) {
    const router = releases.find((item) => item.id === ROUTER_RELEASE)!;
    router.config = { ...router.config, costPolicy: options.routerCostPolicy } as never;
  }
  const built = routingApp({
    releases,
    credentials: [
      { id: 'acd-hmac' },
      { id: 'acd-key' },
      { id: 'restricted', permittedAgentIds: ['someone-else'] },
    ],
    operations: { organizationId: WORKSPACE, routing, humanQueues: queues } as never,
    transferEnabled: options.transferEnabled ?? true,
    humanQueueEnabled: options.humanQueueEnabled ?? true,
    humanQueueWebhookEnabled: options.humanQueueWebhookEnabled ?? true,
    roomConfigured: options.roomConfigured ?? true,
  });
  apps.push(built.app);
  await routing.pools.create(
    RoutingPoolDefinition.parse(
      poolInput('Sales', [
        ['sales-en', ['en']],
        ['sales-hi', ['hi']],
      ]),
    ),
    POOL_SALES,
  );
  await routing.pools.create(
    RoutingPoolDefinition.parse(poolInput('Support', [['support', ['en']]])),
    POOL_SUPPORT,
  );
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    built.app.inject({ method, url, payload: payload as never });
  return { ...built, routing, queues, call };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export const bound = (queueId: string, patch: Record<string, unknown> = {}) => {
  const draft = draftInput();
  draft.humanQueues = [{ key: KEY, queueId, priority: 1 }];
  draft.nodes[0].fallback.splice(1, 0, { kind: 'human', queueId: KEY });
  return Object.assign(draft, patch);
};

export async function codes(s: Setup, draft: Record<string, unknown>) {
  const point = (await s.call('POST', '/v1/routing/points', { draft: draftInput() })).json();
  const checked = await s.call('POST', `/v1/routing/points/${point.id}/validate`, { draft });
  expect(checked.statusCode, checked.body).toBe(200);
  return (checked.json().issues as { code: string; severity: string; path: unknown[] }[])
    .filter((issue) => issue.code.startsWith('routing_queue_'))
    .map((issue) => `${issue.code}:${issue.severity}`);
}
export const make = (s: Setup, definition: Record<string, unknown>) =>
  s.queues.queues.create(HumanQueueDefinition.parse(definition));
/** A queue stored as a legacy row would be: the destination allow-list the schema now requires, emptied. */
export const withEmptyAllowList = (s: Setup) => {
  const parsed = HumanQueueDefinition.parse(external());
  if (parsed.kind !== 'external') throw new Error('kind');
  return s.queues.queues.create({
    ...parsed,
    destination: { ...parsed.destination, allowE164Prefixes: [], allowSipHosts: [] },
  });
};
