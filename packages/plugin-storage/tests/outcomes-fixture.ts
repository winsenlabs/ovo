import { expect } from 'vitest';
import type { CallOutcomeStore, SessionEventInput } from '../src/outcomes/index.ts';

const at = '2026-10-06T10:00:00.000Z';
let id = 0;
export const event = (type: string, payload: Record<string, unknown>): SessionEventInput => ({
  id: `event-${++id}`,
  at,
  type,
  payload,
});

/** A collections call, as the flow would record it. */
export const COLLECTIONS_CALL: readonly [string, Record<string, unknown>][] = [
  ['turn.route', { turn: 1, tier: 'rule', node: 'identity', intent: 'yes', confidence: 1 }],
  ['flow.state', { turn: 1, from: 'identity', to: 'disclose' }],
  [
    'turn.route',
    { turn: 2, tier: 'jev', node: 'disclose', intent: 'promise_to_pay', confidence: 0.9 },
  ],
  ['variables.captured', { turn: 2, variables: { promised_date: '2026-10-07' } }],
  ['flow.state', { turn: 2, from: 'disclose', to: 'ptp_tomorrow' }],
  ['flow.state', { turn: 2, from: 'ptp_tomorrow', to: 'ptp_tomorrow', reason: 'reprompt' }],
  ['turn.route', { turn: 3, tier: 'llm', node: 'ptp_tomorrow', fallbackReason: 'jev_other' }],
  [
    'guardrail',
    { turn: 3, action: 'blocked', findings: [{ kind: 'offer', text: 'waiver' }], checkUs: 35 },
  ],
  ['disposition', { disposition: 'promise_to_pay', node: 'ptp_tomorrow', source: 'jev' }],
  ['flow.state', { turn: 4, from: 'ptp_tomorrow', to: 'goodbye' }],
  ['call.outcome', { outcome: 'completed', reason: 'decision:intent=goodbye' }],
];

export async function expectCollectionsOutcome(store: CallOutcomeStore, workspaceId: string) {
  const events = COLLECTIONS_CALL.map(([type, payload]) => event(type, payload));
  expect(await store.append(workspaceId, 'call-1', events.slice(0, 5))).toBe(5);
  // A retried batch is idempotent: only the new events count.
  expect(await store.append(workspaceId, 'call-1', events.slice(3))).toBe(events.length - 5);
  const outcome = await store.get(workspaceId, 'call-1');
  expect(outcome).toMatchObject({
    callId: 'call-1',
    outcome: 'completed',
    endReason: 'decision:intent=goodbye',
    disposition: 'promise_to_pay',
    dispositionSource: 'jev',
    finalNode: 'goodbye',
    statePath: ['identity', 'disclose', 'ptp_tomorrow', 'goodbye'],
    variables: { promised_date: '2026-10-07' },
    tiers: { rule: 1, jev: 1, llm: 1 },
    guardrail: { flagged: 0, blocked: 1 },
    events: COLLECTIONS_CALL.length,
  });
  const page = await store.listEvents(workspaceId, 'call-1', 4);
  expect(page.items.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
  expect(page.items[0]).toMatchObject({ type: 'turn.route', payload: { tier: 'rule' } });
  const rest = await store.listEvents(workspaceId, 'call-1', 100, page.nextCursor!);
  expect(rest.items).toHaveLength(COLLECTIONS_CALL.length - 4);
  expect(rest.nextCursor).toBeNull();
  await expect(store.listEvents(workspaceId, 'call-1', 10, 'x')).rejects.toThrow(/cursor/);
  expect(await store.get(`${workspaceId}-other`, 'call-1')).toBeUndefined();
  const many = await store.getMany(workspaceId, ['call-1', 'call-missing']);
  expect([...many.keys()]).toEqual(['call-1']);
  await expect(
    store.append(workspaceId, 'call-1', [event('turn.route', { tier: 'nonsense', turn: 1 })]),
  ).rejects.toThrow();
}
