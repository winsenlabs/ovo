import { expect } from 'vitest';
import type { CallOutcomeStore, SessionEventInput } from '../src/outcomes/index.ts';
import { ROUTED_CALL, ROUTING } from './outcomes-route-fixture.ts';
import { TRANSFERRED_CALL } from './outcomes-transfer-fixture.ts';
import { MANAGED_HUMAN_CALL } from './outcomes-human-fixture.ts';

type Step = readonly [string, Record<string, unknown>];

export const POINT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const BILLING_POOL = '88888888-8888-4888-8888-888888888888';
export const WINDOW = {
  since: '2026-10-20T10:00:00.000Z',
  until: '2026-10-20T13:00:00.000Z',
  bucket: 'hour' as const,
};

let ids = 0;
/** Every event of a call at one instant, so the call's `updatedAt` is that instant. */
function timed(steps: readonly Step[], at: string): SessionEventInput[] {
  return steps.map(([type, payload]) => ({ id: `routed-${++ids}`, at, type, payload }));
}

/** `ROUTED_CALL` with its decision patched and extra steps before the closing outcome. */
function routed(
  decision: Record<string, unknown>,
  extra: readonly Step[] = [],
  base: readonly Step[] = ROUTED_CALL,
): Step[] {
  const steps: Step[] = base.map(([type, payload]) =>
    type === 'route.decision' ? [type, { ...payload, ...decision }] : [type, payload],
  );
  const closing = steps.pop()!;
  return [...steps, ...extra, closing];
}
const noAgent = {
  agentId: undefined,
  releaseId: undefined,
  poolId: undefined,
  memberId: undefined,
};

const fallback = (step: string, result = 'taken', attempt = 1): Step => [
  'route.fallback',
  { turn: 1, node: 'intent', step, result, attempt },
];

/** The calls of `seedRoutedCalls`, by call id, with when each last changed. */
export const SEEDED: Record<string, { at: string; steps: readonly Step[] }> = {
  'c-hi': {
    at: '2026-10-20T10:05:00.000Z',
    steps: routed({ turns: 2, routeMs: 2_000 }, [fallback('reask')]),
  },
  'c-en': {
    at: '2026-10-20T10:20:00.000Z',
    steps: routed({ turns: 1, routeMs: 1_000, agentId: 'sales-en', memberId: 'sales-en' }),
  },
  'c-def': {
    at: '2026-10-20T11:10:00.000Z',
    steps: routed({ turns: 3, routeMs: 4_000, ...noAgent }, [fallback('default')]),
  },
  'c-human': {
    at: '2026-10-20T11:30:00.000Z',
    steps: routed(
      { routingPointId: POINT_B, target: 'human', turns: 2, routeMs: 3_000, ...noAgent },
      [],
      MANAGED_HUMAN_CALL,
    ),
  },
  'c-end': {
    at: '2026-10-20T12:05:00.000Z',
    steps: routed(
      { target: 'end', turns: 2, routeMs: 500, degraded: 'router_compose_failed', ...noAgent },
      [fallback('end'), fallback('callback', 'skipped')],
    ),
  },
  'c-undec': { at: '2026-10-20T12:10:00.000Z', steps: ROUTED_CALL.slice(0, 2) },
  'c-xfer': { at: '2026-10-20T12:10:00.000Z', steps: TRANSFERRED_CALL },
  'c-direct': {
    at: '2026-10-20T12:11:00.000Z',
    steps: [['call.outcome', { outcome: 'completed', reason: 'x' }]],
  },
};

/** Seeds the calls above, and one routed call of another workspace that must never show. */
export async function seedRoutedCalls(store: CallOutcomeStore, workspaceId: string) {
  for (const [callId, { at, steps }] of Object.entries(SEEDED))
    await store.append(workspaceId, callId, timed(steps, at));
  await store.append(
    `${workspaceId}-other`,
    'c-other',
    timed(ROUTED_CALL, '2026-10-20T11:00:00.000Z'),
  );
}

/** Newest first, ties by call id descending: what `findRouted` must return for no filter. */
export const ROUTED_ORDER = ['c-xfer', 'c-undec', 'c-end', 'c-human', 'c-def', 'c-en', 'c-hi'];

export async function idsOf(
  store: CallOutcomeStore,
  workspaceId: string,
  filter: Parameters<CallOutcomeStore['findRouted']>[1],
) {
  const page = await store.findRouted(workspaceId, filter, 100);
  expect(page.nextCursor).toBeNull();
  return page.items.map((item) => item.callId);
}

/** The filters and cursor behaviour, hand-checked against `SEEDED`. */
export async function expectRoutedFilters(store: CallOutcomeStore, workspaceId: string) {
  await seedRoutedCalls(store, workspaceId);
  expect(await idsOf(store, workspaceId, {})).toEqual(ROUTED_ORDER);
  expect(await idsOf(store, workspaceId, { pointId: ROUTING.point })).toEqual(
    ROUTED_ORDER.filter((id) => id !== 'c-human' && id !== 'c-undec'),
  );
  expect(await idsOf(store, workspaceId, { pointId: POINT_B })).toEqual(['c-human']);
  expect(await idsOf(store, workspaceId, { routingReleaseId: ROUTING.release })).toEqual(
    ROUTED_ORDER.filter((id) => id !== 'c-undec'),
  );
  expect(await idsOf(store, workspaceId, { fallback: true })).toEqual(['c-end', 'c-def']);
  expect(await idsOf(store, workspaceId, { fallback: false })).toEqual([
    'c-xfer',
    'c-undec',
    'c-human',
    'c-en',
    'c-hi',
  ]);
  expect(await idsOf(store, workspaceId, { transferred: true })).toEqual(['c-xfer']);
  expect(await idsOf(store, workspaceId, { human: true })).toEqual(['c-human']);
  expect(await idsOf(store, workspaceId, { segmentAgentId: 'billing' })).toEqual(['c-xfer']);
  expect(await idsOf(store, workspaceId, { segmentAgentId: 'queue:floor' })).toEqual(['c-human']);
  expect(await idsOf(store, workspaceId, { poolId: ROUTING.pool })).toEqual([
    'c-xfer',
    'c-en',
    'c-hi',
  ]);
  expect(await idsOf(store, workspaceId, { poolId: BILLING_POOL })).toEqual(['c-xfer']);
  expect(await idsOf(store, workspaceId, { memberId: 'sales-hi' })).toEqual(['c-xfer', 'c-hi']);
  expect(await idsOf(store, workspaceId, { poolId: BILLING_POOL, memberId: 'sales-hi' })).toEqual([
    'c-xfer',
  ]);
  expect(await idsOf(store, workspaceId, { pointId: ROUTING.point, human: true })).toEqual([]);
  expect(await idsOf(store, workspaceId, { since: '2026-10-20T12:00:00.000Z' })).toEqual([
    'c-xfer',
    'c-undec',
    'c-end',
  ]);
  expect(
    await idsOf(store, workspaceId, {
      since: '2026-10-20T11:00:00.000Z',
      until: '2026-10-20T12:10:00.000Z',
    }),
  ).toEqual(['c-end', 'c-human', 'c-def']);
  // The other workspace's call never shows, and a direct call is not a routed one.
  expect(await idsOf(store, `${workspaceId}-other`, {})).toEqual(['c-other']);
  expect(await idsOf(store, `${workspaceId}-none`, {})).toEqual([]);

  // Walking one at a time crosses the tie at 12:10 without a repeat or a gap.
  const walked: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.findRouted(workspaceId, {}, 1, cursor);
    walked.push(...page.items.map((item) => item.callId));
    expect(page.items.length).toBeLessThanOrEqual(1);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(walked).toEqual(ROUTED_ORDER);
  const first = await store.findRouted(workspaceId, {}, 3);
  expect(first.items.map((item) => item.callId)).toEqual(ROUTED_ORDER.slice(0, 3));
  expect(first.items[0]!.updatedAt).toBe('2026-10-20T12:10:00.000Z');
  const second = await store.findRouted(workspaceId, {}, 3, first.nextCursor!);
  expect(second.items.map((item) => item.callId)).toEqual(ROUTED_ORDER.slice(3, 6));
  await expect(store.findRouted(workspaceId, {}, 3, '!!')).rejects.toThrow(/cursor/);
  await expect(
    store.findRouted(workspaceId, {}, 3, Buffer.from('nonsense').toString('base64url')),
  ).rejects.toThrow(/cursor/);
}
