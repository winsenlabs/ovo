import { describe, expect, it } from 'vitest';
import { MemoryCallOutcomeStore } from '../src/outcomes/index.ts';
import { applySessionEvent, emptyCallOutcome } from '../src/outcomes/projection.ts';
import { ROUTED_CALL, ROUTED_SUMMARY, expectRoutedOutcomes } from './outcomes-route-fixture.ts';
import { readSessionEvent } from '@winsendotai/ovo-contracts';

describe('route outcome fold (Wave 15)', () => {
  it('starts with no route', () => {
    expect(emptyCallOutcome('call', '2026-10-15T00:00:00.000Z').route).toBeNull();
  });

  it('folds route.decision and route.segment in the memory store', async () => {
    await expectRoutedOutcomes(new MemoryCallOutcomeStore(), 'ws-route');
  });

  it('is pure: the same events give the same route in any store, without mutating input', () => {
    let summary = emptyCallOutcome('call', '2026-10-15T00:00:00.000Z');
    const snapshots = [];
    for (const [type, payload] of ROUTED_CALL) {
      const before = structuredClone(summary);
      const next = applySessionEvent(
        summary,
        readSessionEvent(type, payload),
        '2026-10-15T00:00:01.000Z',
      );
      expect(summary).toEqual(before);
      snapshots.push(next.route?.segments ?? 0);
      summary = next;
    }
    expect(snapshots).toEqual([1, 1, 1, 1, 2, 2]);
    expect(summary.route).toEqual(ROUTED_SUMMARY);
    expect(summary.events).toBe(ROUTED_CALL.length);
  });

  it('keeps a decision without an agent (end, callback) free of the router segment', () => {
    let summary = emptyCallOutcome('call', '2026-10-15T00:00:00.000Z');
    for (const [type, payload] of [
      ROUTED_CALL[0]!,
      [
        'route.decision',
        {
          routingPointId: 'p',
          routingReleaseId: 'r',
          path: ['intent'],
          target: 'end',
          turns: 3,
          routeMs: 9,
        },
      ],
    ] as const)
      summary = applySessionEvent(summary, readSessionEvent(type, payload), 'now');
    expect(summary.route).toMatchObject({
      target: 'end',
      agentId: null,
      releaseId: null,
      segments: 1,
    });
  });
});
