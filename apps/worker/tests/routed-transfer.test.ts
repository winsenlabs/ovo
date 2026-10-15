import { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_RELEASE,
  POOL_SALES,
  POOL_SUPPORT,
  transferSnapshotInput,
} from '../../../packages/contracts/tests/transfer-fixture.ts';
import {
  DEFAULT_RELEASE,
  POINT_ID,
  ROUTER_RELEASE,
  SALES_EN_RELEASE,
  SUPPORT_RELEASE,
  snapshot as r1Snapshot,
} from '../../../packages/contracts/tests/routing-fixture.ts';
import { fixtureRelease, routedCall } from './routed-fixtures.ts';

const ROUTING_RELEASE = '12121212-1212-4121-8121-121212121212';
const routing = {
  routingReleaseId: ROUTING_RELEASE,
  routingPointId: POINT_ID,
  version: 4,
  defaultReleaseId: DEFAULT_RELEASE,
};
const releases = () => [
  fixtureRelease(ROUTER_RELEASE, 'front-desk', { mode: 'context', maxCallSeconds: 600 }),
  fixtureRelease(DEFAULT_RELEASE, 'sales-default'),
  fixtureRelease(SALES_EN_RELEASE, 'sales-en'),
  fixtureRelease(SUPPORT_RELEASE, 'support'),
  fixtureRelease(BILLING_RELEASE, 'billing'),
];
const stored = (snapshot = RoutingReleaseSnapshot.parse(transferSnapshotInput())) => ({
  id: ROUTING_RELEASE,
  routingPointId: POINT_ID,
  snapshot,
});
const signal = () => new AbortController().signal;

async function routedToSales(transfer: boolean, snapshot?: RoutingReleaseSnapshot) {
  const call = await routedCall({
    releases: releases(),
    routerReleaseId: ROUTER_RELEASE,
    routing,
    getRouting: async () => stored(snapshot),
    transfer,
  });
  const session = await call.open();
  const [router] = call.routers;
  return { call, session, router: router! };
}

describe('routed calls with in-call transfers on (transfer design 7.1-7.3)', () => {
  it('routes, then transfers from agent to agent on one link, with one engine at a time', async () => {
    const { call, session, router } = await routedToSales(true);
    expect(router.handoff.begin).toBeTypeOf('function');
    const begun = await router.handoff.begin!(
      {
        kind: 'agent',
        reason: 'route',
        agentId: 'sales-en',
        releaseId: SALES_EN_RELEASE,
        variables: { ovo_route_intent: 'sales' },
        route: { path: ['intent'], poolId: POOL_SALES, memberId: 'sales-en' },
      },
      signal(),
    );
    if (!begun.ok) throw new Error(begun.reason);
    router.handoff.commit(begun.handoffId);
    const [routerEngine] = call.engines;
    await routerEngine!.complete();
    await vi.waitFor(() => expect(call.engines[1]?.started).toBe(true));
    const sales = call.engines[1]!;
    expect(sales.releaseId).toBe(SALES_EN_RELEASE);
    // Granted by its pool: every target but none outside the catalogue.
    expect(sales.transfer!.targets().map((target) => target.key)).toEqual([
      'support',
      'another_language',
      'senior',
      'billing',
    ]);
    expect(sales.transfer!.inbound).toMatchObject({
      kind: 'route',
      from: { role: 'router', releaseId: ROUTER_RELEASE },
    });
    const requested = await sales.transfer!.request(
      { key: 'billing', source: 'llm', summary: 'Wants a refund.', confirmed: false },
      signal(),
    );
    expect(requested).toMatchObject({
      ok: true,
      announcement: 'Let me transfer you to the right team. Please stay on the line.',
      queued: false,
    });
    if (!requested.ok) return;
    sales.transfer!.commit(requested.transferId);
    await sales.complete();
    await vi.waitFor(() => expect(call.engines[2]?.started).toBe(true));
    const billing = call.engines[2]!;
    expect(billing.releaseId).toBe(BILLING_RELEASE);
    expect(sales.disposed).toBe('behavior_completed');
    // Neither agent's ending hung up or closed the link while the call handed on.
    expect(call.beforeClose).not.toHaveBeenCalled();
    expect(call.link.closed).toEqual([]);
    expect(billing.transfer!.inbound).toMatchObject({
      kind: 'transfer',
      transfer: 1,
      targetKey: 'billing',
      summary: 'Wants a refund.',
      from: { role: 'agent', agentId: 'sales-en', releaseId: SALES_EN_RELEASE },
    });
    // Its usage is tagged with its segment, and its audits carry the index.
    billing.usage!({
      provider: 'fixture',
      operation: 'tts',
      unit: 'characters',
      quantity: '12',
      requestId: 'r1',
      state: 'estimated',
    } as never);
    expect(call.segmentUsage.map(([job, segment]) => [job, segment])).toEqual([['job-1', 2]]);
    expect(call.audits).toContainEqual(['provider.meter', expect.objectContaining({ segment: 2 })]);
    await billing.complete();
    expect(call.beforeClose).toHaveBeenCalledOnce();
    expect(call.beforeClose.mock.calls[0]![0].payload.releaseId).toBe(BILLING_RELEASE);
    await session.dispose('behavior_completed');
    const events = await call.events();
    expect(events.map(([type]) => type)).toEqual([
      'route.segment',
      'segment.ended',
      'route.segment',
      'transfer.requested',
      'segment.ended',
      'route.segment',
      'transfer.completed',
      'segment.ended',
      'call.outcome',
    ]);
    expect(events[5]![1]).toMatchObject({
      index: 2,
      reason: 'transfer',
      transfer: 1,
      fromIndex: 1,
    });
    expect(events[6]![1]).toMatchObject({
      transfer: 1,
      outcome: 'connected',
      releaseId: BILLING_RELEASE,
    });
    expect(events[7]![1]).toMatchObject({
      index: 2,
      ended: 'call_end',
      usage: { 'fixture.streaming-tts.characters': 12 },
    });
    // The transferring LLM's words reach the target's port only: never an event.
    expect(JSON.stringify(events)).not.toContain('refund');
  });

  it("audits a transfer's claim outage as the transfer's own and proceeds unclaimed", async () => {
    const { call, session, router } = await routedToSales(true);
    const begun = await router.handoff.begin!(
      {
        kind: 'agent',
        reason: 'route',
        agentId: 'sales-en',
        releaseId: SALES_EN_RELEASE,
        variables: {},
        route: { path: ['intent'], poolId: POOL_SALES, memberId: 'sales-en' },
      },
      signal(),
    );
    if (!begun.ok) throw new Error(begun.reason);
    router.handoff.commit(begun.handoffId);
    await call.engines[0]!.complete();
    await vi.waitFor(() => expect(call.engines[1]?.started).toBe(true));
    call.claims.claim.mockRejectedValue(new Error('claim storage down'));
    const requested = await call.engines[1]!.transfer!.request(
      { key: 'support', source: 'llm', confirmed: false },
      signal(),
    );
    expect(requested).toMatchObject({ ok: true });
    expect(call.claims.claim).toHaveBeenCalled();
    const outages = call.audits.filter(([type]) => type.endsWith('.claims.unavailable'));
    expect(outages).toEqual([['transfer.claims.unavailable', { poolId: POOL_SUPPORT }]]);
    await session.dispose('caller_hangup');
  });

  it('re-routes through the tree: the router comes back with its entry, then hands on', async () => {
    const { call, session, router } = await routedToSales(true);
    const begun = await router.handoff.begin!(
      {
        kind: 'agent',
        reason: 'route',
        agentId: 'sales-en',
        releaseId: SALES_EN_RELEASE,
        variables: {},
        route: { path: ['intent'], poolId: POOL_SALES, memberId: 'sales-en' },
      },
      signal(),
    );
    if (!begun.ok) throw new Error(begun.reason);
    router.handoff.commit(begun.handoffId);
    await call.engines[0]!.complete();
    await vi.waitFor(() => expect(call.engines[1]?.started).toBe(true));
    const sales = call.engines[1]!;
    const requested = await sales.transfer!.request(
      { key: 'another_language', source: 'llm', confirmed: false },
      signal(),
    );
    if (!requested.ok) throw new Error(requested.reason);
    sales.transfer!.commit(requested.transferId);
    await sales.complete();
    await vi.waitFor(() => expect(call.routers).toHaveLength(2));
    const reroute = call.routers[1]!;
    expect(reroute.config).toMatchObject({
      entry: { node: 'intent', path: [], disclosed: [], transfer: 1 },
    });
    await vi.waitFor(() => expect(call.engines[2]?.started).toBe(true));
    expect(call.engines[2]!.transfer).toBeUndefined();
    const handoff = await reroute.handoff.begin!(
      {
        kind: 'agent',
        reason: 'transfer',
        agentId: 'support',
        releaseId: SUPPORT_RELEASE,
        variables: {},
        transfer: { source: 'router' },
      },
      signal(),
    );
    if (!handoff.ok) throw new Error(handoff.reason);
    reroute.handoff.commit(handoff.handoffId);
    await call.engines[2]!.complete();
    await vi.waitFor(() => expect(call.engines[3]?.started).toBe(true));
    expect(call.engines[3]!.transfer!.inbound).toMatchObject({ kind: 'transfer', transfer: 1 });
    await session.dispose('caller_hangup');
    const events = (await call.events()) as [string, Record<string, unknown>][];
    const segments = events.filter(([type]) => type === 'route.segment');
    expect(segments.map(([, payload]) => [payload.index, payload.role, payload.reason])).toEqual([
      [0, 'router', 'start'],
      [1, 'agent', 'route'],
      [2, 'router', 'reroute'],
      [3, 'agent', 'transfer'],
    ]);
    const completed = events.filter(([type]) => type === 'transfer.completed');
    // One transfer: the re-route and its final handoff complete it once.
    expect(completed.map(([, payload]) => [payload.transfer, payload.outcome])).toEqual([
      [1, 'connected'],
    ]);
    expect(call.audits).toContainEqual(['transfer.rerouted', { transfer: 1, segment: 2 }]);
  });

  it('keeps Wave 15 routing exactly when the flag is off: no begin, no transfer port', async () => {
    const { call, router } = await routedToSales(false, r1Snapshot());
    expect(router.handoff.begin).toBeUndefined();
    const prepared = await router.handoff.prepare(
      {
        kind: 'agent',
        reason: 'route',
        agentId: 'support',
        releaseId: SUPPORT_RELEASE,
        variables: {},
      },
      signal(),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    router.handoff.commit(prepared.handoffId);
    await call.engines[0]!.complete();
    await vi.waitFor(() => expect(call.engines[1]?.started).toBe(true));
    expect(call.engines[1]!.transfer).toBeUndefined();
    expect(call.segmentUsage).toEqual([]);
  });

  it('without a routing snapshot a call with transfers on degrades as in Wave 15', async () => {
    const call = await routedCall({
      releases: releases(),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting: async () => undefined,
      transfer: true,
    });
    await call.open();
    expect(call.routers).toEqual([]);
    expect(call.engines.map((engine) => engine.releaseId)).toEqual([DEFAULT_RELEASE]);
    expect(call.engines[0]!.transfer).toBeUndefined();
  });
});
