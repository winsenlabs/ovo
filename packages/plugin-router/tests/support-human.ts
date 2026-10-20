import type { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { exampleRoutingSnapshot } from '../src/testing.ts';

export const DESK_ID = '00000000-0000-4000-8000-0000000000e1';

/** Kolkata office hours, Monday to Friday 09:00-18:00: Thursday noon is open, 22:30 is not. */
export const OFFICE = {
  timezone: 'Asia/Kolkata',
  weekly: Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};

/**
 * The example release with a managed queue bound as `desk`: the `intent` node falls back to a
 * person, then to a callback. `queue` patches the queue definition (hours, a hold ...) and
 * `transfer` adds a transfer policy (schema 3 keeps it beside the queues).
 */
export function deskSnapshot(
  over: { queue?: Record<string, unknown>; transfer?: Record<string, unknown> } = {},
): RoutingReleaseSnapshot {
  return exampleRoutingSnapshot((raw) => {
    raw.schemaVersion = 3;
    raw.transfer = over.transfer ?? {};
    raw.nodes[0].fallback = [
      { kind: 'human', queueId: 'desk' },
      { kind: 'callback', inMinutes: 60, line: { en: 'We will call you back.' } },
    ];
    raw.humanQueues = [{ key: 'desk', queueId: DESK_ID, priority: 0 }];
    raw.queues = {
      [DESK_ID]: {
        id: DESK_ID,
        version: 1,
        key: 'desk',
        priority: 0,
        definition: {
          kind: 'managed',
          name: 'Desk',
          announcement: { en: 'A colleague will take over.' },
          ...over.queue,
        },
      },
    };
  });
}
