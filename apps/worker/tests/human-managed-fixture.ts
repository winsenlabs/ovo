import { expect, vi } from 'vitest';
import { humanHarness, managedQueue } from './human-fixtures.ts';
import { holdPolicy, signal, transferPolicy } from './transfer-fixtures.ts';

export const onTimeout = [
  { kind: 'default' as const },
  { kind: 'end' as const, line: { en: 'Goodbye.' } },
];
export const policy = () => transferPolicy({ hold: holdPolicy({ maxSeconds: 60, onTimeout }) });

type Options = Parameters<typeof humanHarness>[0];
export const harness = (options: Options = {}) =>
  humanHarness({ queues: [managedQueue()], policy: policy(), ...options });
export type Harness = ReturnType<typeof harness>;

export const request = (queueId = 'desk') =>
  ({
    kind: 'human',
    reason: 'route',
    queueId,
    variables: { ovo_route_intent: 'billing' },
  }) as const;

/** The router asks for the desk, announces, and its engine ends into the handoff. */
export async function handOver(h: Harness, queueId = 'desk') {
  const router = await h.started();
  const begun = await h.controller.begin(request(queueId), signal());
  if (!begun.ok) throw new Error(begun.reason);
  h.controller.commit(begun.handoffId);
  await router.complete();
  return begun;
}

export const events = (h: Harness, type: string) =>
  h.recorded.filter(([name]) => name === type).map(([, payload]) => payload);

/** An operator accepts and walks into the room; the call is connected to them. */
export async function connect(h: Harness, operator = 'ana') {
  await handOver(h);
  await h.clock.advance(200);
  await h.service.accept(h.service.id(1), operator);
  await h.clock.advance(200);
  h.rooms.seat().join(`op:${operator}`);
  await h.clock.advance(200);
  await vi.waitFor(() => expect(h.controller.attached?.role).toBe('human'));
}
