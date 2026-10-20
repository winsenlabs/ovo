import { describe, expect, it } from 'vitest';
import { readSessionEvent } from '@winsendotai/ovo-contracts';
import { applySessionEvent, emptyCallOutcome } from '../src/outcomes/projection.ts';
import { MemoryCallOutcomeStore } from '../src/outcomes/index.ts';
import { event } from './outcomes-fixture.ts';
import { ROUTED_CALL, ROUTING } from './outcomes-route-fixture.ts';

const AT = '2026-10-20T10:00:00.000Z';
const fallback = (step: string, result: string, attempt = 1) =>
  ['route.fallback', { turn: 1, node: 'intent', step, result, attempt }] as const;

function fold(steps: readonly (readonly [string, Record<string, unknown>])[]) {
  let summary = emptyCallOutcome('call', AT);
  for (const [type, payload] of steps)
    summary = applySessionEvent(summary, readSessionEvent(type, payload), AT);
  return summary;
}

describe('route fold: turns, routeMs, fallbacks and reasks (Wave 18)', () => {
  it('takes turns and routeMs from the decision', () => {
    expect(fold(ROUTED_CALL).route).toMatchObject({ turns: 1, routeMs: 2_100 });
  });

  it('counts taken and failed steps as fallbacks, a taken reask as a reask, a skip as neither', () => {
    const route = fold([
      ROUTED_CALL[0]!,
      fallback('reask', 'taken'),
      fallback('reask', 'taken', 2),
      fallback('reask', 'skipped', 3),
      fallback('default', 'failed'),
      fallback('human', 'skipped'),
      fallback('target', 'failed'),
      fallback('callback', 'taken'),
      ROUTED_CALL[3]!,
    ]).route!;
    expect(route).toMatchObject({ reasks: 2, fallbacks: 3, segments: 1 });
  });

  it('keeps counts that arrive before the decision, and after it', () => {
    const before = fold([fallback('default', 'taken'), ROUTED_CALL[3]!]).route!;
    expect(before).toMatchObject({ fallbacks: 1, reasks: 0, routingPointId: ROUTING.point });
    const after = fold([ROUTED_CALL[3]!, fallback('reask', 'taken')]).route!;
    expect(after).toMatchObject({ fallbacks: 0, reasks: 1, turns: 1 });
  });

  it('a fallback alone makes an undecided route with its count', () => {
    expect(fold([fallback('default', 'taken')]).route).toMatchObject({
      routingPointId: '',
      fallbacks: 1,
    });
  });

  it('leaves a route that never saw them without the fields (rows from before Wave 18)', () => {
    const route = fold([ROUTED_CALL[0]!]).route!;
    expect(route.turns).toBeUndefined();
    expect(route.fallbacks).toBeUndefined();
  });

  it('is pure and the memory store folds the same', async () => {
    const steps = [ROUTED_CALL[0]!, fallback('reask', 'taken'), ...ROUTED_CALL.slice(3)] as const;
    const summary = fold(steps);
    const before = structuredClone(summary);
    applySessionEvent(summary, readSessionEvent(...fallback('default', 'taken')), AT);
    expect(summary).toEqual(before);
    const store = new MemoryCallOutcomeStore();
    await store.append(
      'ws',
      'call',
      steps.map(([type, payload]) => event(type, payload)),
    );
    expect((await store.get('ws', 'call'))!.route).toEqual(summary.route);
  });
});
