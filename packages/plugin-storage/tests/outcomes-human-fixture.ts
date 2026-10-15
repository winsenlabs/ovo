import { expect } from 'vitest';
import type { CallOutcomeStore } from '../src/outcomes/index.ts';
import { event } from './outcomes-fixture.ts';
import { ROUTED_CALL } from './outcomes-route-fixture.ts';

type Step = readonly [string, Record<string, unknown>];
const QUEUE = 'abcdef01-0000-4000-8000-000000000001';

const requested = (extra: Record<string, unknown> = {}): Step => [
  'human.requested',
  {
    queue: 'floor',
    queueId: QUEUE,
    kind: 'managed',
    ticket: 't1',
    source: 'router',
    result: 'accepted',
    ...extra,
  },
];
const state = (name: string, extra: Record<string, unknown> = {}): Step => [
  'human.state',
  { ticket: 't1', state: name, by: 'operator', ...extra },
];
const completed = (extra: Record<string, unknown> = {}): Step => [
  'human.completed',
  { ticket: 't1', queue: 'floor', kind: 'managed', outcome: 'ended', waitMs: 12_000, ...extra },
];

/** A router call handed to the operator desk: requested, offered, accepted, connected, ended. */
export const MANAGED_HUMAN_CALL: readonly Step[] = [
  ...ROUTED_CALL.slice(0, -1),
  requested(),
  state('waiting', { by: 'worker' }),
  state('accepted', { operator: 'u1' }),
  state('connected', { operator: 'u1', by: 'worker', waitMs: 12_000 }),
  [
    'route.segment',
    {
      index: 2,
      role: 'human',
      agentId: 'queue:floor',
      releaseId: QUEUE,
      reason: 'route',
      queueId: QUEUE,
      ticketId: 't1',
      kind: 'managed',
    },
  ],
  completed({ talkMs: 61_000, operator: 'u1', segment: 2 }),
  ROUTED_CALL.at(-1)!,
];

const external = (extra: Record<string, unknown> = {}) => requested({ kind: 'external', ...extra });

/** An external queue hand-off: the leg left OVO, then the third party's callbacks arrived. */
export const EXTERNAL_HUMAN_CALL: readonly Step[] = [
  ...ROUTED_CALL.slice(0, -1),
  external(),
  ['human.webhook', { ticket: 't1', attempt: 1, outcome: 'accepted', status: 200, ms: 41 }],
  state('handed_off', { by: 'worker' }),
  completed({ kind: 'external', outcome: 'handed_off', waitMs: 4_000 }),
  ['call.outcome', { outcome: 'transferred', reason: 'transferred' }],
];
export const EXTERNAL_CALLBACKS: readonly Step[] = [
  state('accepted', { by: 'callback', callback: 'accepted' }),
  state('released', { by: 'callback', callback: 'outcome', code: 'answered' }),
  state('released', { by: 'callback', callback: 'released' }),
];

const HUMAN_DEFAULTS = {
  queueKey: 'floor',
  queueId: QUEUE,
  kind: 'managed',
  ticket: 't1',
  requested: 1,
  connected: 1,
  waitMs: 12_000,
  talkMs: 61_000,
  outcome: 'ended',
  operator: 'u1',
  callbacks: { accepted: false, released: false, outcome: null },
};

/** Folds the human queue events through any store. */
export async function expectHumanOutcomes(store: CallOutcomeStore, workspaceId: string) {
  const append = (callId: string, steps: readonly Step[]) =>
    store.append(
      workspaceId,
      callId,
      steps.map(([type, payload]) => event(type, payload)),
    );

  await append('managed', MANAGED_HUMAN_CALL);
  const managed = (await store.get(workspaceId, 'managed'))!;
  expect(managed.human).toEqual(HUMAN_DEFAULTS);
  expect(managed.segments.map((s) => [s.index, s.role, s.reason])).toEqual([
    [0, 'router', 'start'],
    [1, 'agent', 'route'],
    [2, 'human', 'route'],
  ]);
  expect(managed.outcome).toBe('completed');

  // A third party's callbacks arrive after the call ended and after call.outcome.
  await append('external', EXTERNAL_HUMAN_CALL);
  const handedOn = (await store.get(workspaceId, 'external'))!;
  expect(handedOn.outcome).toBe('transferred');
  expect(handedOn.human).toEqual({
    ...HUMAN_DEFAULTS,
    kind: 'external',
    connected: 0,
    waitMs: 4_000,
    talkMs: null,
    outcome: 'handed_off',
    operator: null,
  });
  await append('external', EXTERNAL_CALLBACKS.slice(0, 1));
  expect((await store.get(workspaceId, 'external'))!.human!.callbacks).toEqual({
    accepted: true,
    released: false,
    outcome: null,
  });
  await append('external', EXTERNAL_CALLBACKS.slice(1));
  const done = (await store.get(workspaceId, 'external'))!;
  expect(done.human!.callbacks).toEqual({ accepted: true, released: true, outcome: 'answered' });
  expect(done.outcome).toBe('transferred');
  expect(done.events).toBe(handedOn.events + 3);

  // An overflow chain: the second queue wins, counts add, per-ticket fields reset.
  await append('chain', [
    requested(),
    completed({ outcome: 'timeout', waitMs: 180_000 }),
    requested({ queue: 'overflow', ticket: 't2', kind: 'external', queueId: 'q2' }),
    state('connected', { ticket: 't2', operator: 'ext', by: 'worker' }),
  ]);
  expect((await store.get(workspaceId, 'chain'))!.human).toEqual({
    queueKey: 'overflow',
    queueId: 'q2',
    kind: 'external',
    ticket: 't2',
    requested: 2,
    connected: 1,
    waitMs: null,
    talkMs: null,
    outcome: null,
    operator: 'ext',
    callbacks: { accepted: false, released: false, outcome: null },
  });

  // A refused request leaves a record that nobody answered; it never overwrites a real one.
  await append('refused', [
    requested({ result: 'refused', refusal: 'no_operators', ticket: undefined }),
  ]);
  expect((await store.get(workspaceId, 'refused'))!.human).toMatchObject({
    queueKey: 'floor',
    requested: 0,
    outcome: 'unavailable',
  });
  await append('refused', [requested(), state('connected', { by: 'worker' })]);
  await append('refused', [requested({ result: 'refused', refusal: 'queue_closed' })]);
  expect((await store.get(workspaceId, 'refused'))!.human).toMatchObject({
    requested: 1,
    connected: 1,
    outcome: null,
  });

  // A webhook attempt alone changes nothing in the summary; a call that never asked has no human.
  await append('webhook-only', [
    ['human.webhook', { ticket: 't', attempt: 1, outcome: 'retry', ms: 5 }],
  ]);
  expect((await store.get(workspaceId, 'webhook-only'))!.human).toBeNull();
  await append('direct', [['call.outcome', { outcome: 'completed', reason: 'x' }]]);
  expect((await store.get(workspaceId, 'direct'))!.human).toBeNull();
}
