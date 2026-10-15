import { expect } from 'vitest';
import type { CallOutcomeStore } from '../src/outcomes/index.ts';
import { event } from './outcomes-fixture.ts';
import { ROUTED_CALL, ROUTED_SUMMARY, ROUTING } from './outcomes-route-fixture.ts';

export const BILLING = '66666666-6666-4666-8666-666666666666';
export const FALLBACK = '77777777-7777-4777-8777-777777777777';
const BILLING_POOL = '88888888-8888-4888-8888-888888888888';

const segment = (index: number, extra: Record<string, unknown>) =>
  [
    'route.segment',
    { index, role: 'agent', agentId: 'billing', releaseId: BILLING, ...extra },
  ] as const;
const ended = (index: number, ended: string, durationMs: number) =>
  [
    'segment.ended',
    {
      index,
      role: 'agent',
      agentId: 'x',
      releaseId: BILLING,
      ended,
      endReason: 'behavior_completed',
      durationMs,
      turns: 3,
    },
  ] as const;
const requested = (result: string, extra: Record<string, unknown> = {}) =>
  [
    'transfer.requested',
    { transfer: 1, fromSegment: 1, source: 'llm', kind: 'agent', key: 'billing', result, ...extra },
  ] as const;
const completed = (outcome: string) =>
  ['transfer.completed', { transfer: 1, outcome, holdMs: 4_100, steps: [] }] as const;

/** An R1 routed call that sales-hi answered, then a refused and an accepted transfer to billing. */
export const TRANSFERRED_CALL: readonly (readonly [string, Record<string, unknown>])[] = [
  ...ROUTED_CALL.slice(0, -1),
  requested('refused', { refusal: 'not_confirmed' }),
  requested('accepted'),
  ended(1, 'handoff', 61_000),
  segment(2, {
    reason: 'transfer',
    transfer: 1,
    language: 'en',
    fromIndex: 1,
    poolId: BILLING_POOL,
    memberId: 'billing-2',
  }),
  completed('connected'),
  ended(2, 'call_end', 30_000),
  ROUTED_CALL.at(-1)!,
];

/** Folds transfers, segments and the fallback-agent fix (R1 audit 3) through any store. */
export async function expectTransferOutcomes(store: CallOutcomeStore, workspaceId: string) {
  const append = (
    callId: string,
    events: readonly (readonly [string, Record<string, unknown>])[],
  ) =>
    store.append(
      workspaceId,
      callId,
      events.map(([type, payload]) => event(type, payload)),
    );

  await append('transferred', TRANSFERRED_CALL);
  const transferred = (await store.get(workspaceId, 'transferred'))!;
  // A transfer never renames the route: it is still the agent routing chose.
  expect(transferred.route).toEqual({ ...ROUTED_SUMMARY, segments: 3 });
  expect(transferred.transfers).toEqual({ requested: 2, refused: 1, connected: 1, failed: 0 });
  expect(
    transferred.segments.map((s) => [s.index, s.role, s.reason, s.durationMs, s.ended]),
  ).toEqual([
    [0, 'router', 'start', null, null],
    [1, 'agent', 'route', 61_000, 'handoff'],
    [2, 'agent', 'transfer', 30_000, 'call_end'],
  ]);
  expect(transferred.segments[2]).toMatchObject({
    agentId: 'billing',
    releaseId: BILLING,
    poolId: BILLING_POOL,
    memberId: 'billing-2',
    language: 'en',
    transfer: 1,
  });
  expect(transferred.segments[0]).toMatchObject({ poolId: null, memberId: null, transfer: null });
  expect(typeof transferred.segments[1]!.startedAt).toBe('string');

  // R1 audit 3: the chosen agent failed to start and the default agent answered instead.
  await append('fell-back', [
    ...ROUTED_CALL.slice(0, 4),
    [
      'route.segment',
      { index: 2, role: 'agent', agentId: 'sales-en', releaseId: FALLBACK, reason: 'fallback' },
    ],
  ]);
  expect((await store.get(workspaceId, 'fell-back'))!.route).toEqual({
    ...ROUTED_SUMMARY,
    agentId: 'sales-en',
    releaseId: FALLBACK,
    poolId: null,
    memberId: null,
    degraded: 'target_start_failed',
  });

  // Failed transfers count; a caller hanging up mid-transfer does not.
  await append('failed', [
    ...ROUTED_CALL.slice(0, 5),
    requested('accepted'),
    completed('returned'),
    requested('accepted', { transfer: 2 }),
    completed('caller_hangup'),
  ]);
  expect((await store.get(workspaceId, 'failed'))!.transfers).toEqual({
    requested: 2,
    refused: 0,
    connected: 0,
    failed: 1,
  });

  // At most 16 segments are kept; the route still counts every one.
  await append(
    'long',
    Array.from({ length: 18 }, (_, index) => segment(index, { reason: 'transfer', transfer: 1 })),
  );
  const long = (await store.get(workspaceId, 'long'))!;
  expect(long.segments).toHaveLength(16);
  expect(long.route!.segments).toBe(18);

  await append('direct', [['call.outcome', { outcome: 'completed', reason: 'x' }]]);
  expect(await store.get(workspaceId, 'direct')).toMatchObject({
    segments: [],
    transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
  });
}

export { ROUTING };
