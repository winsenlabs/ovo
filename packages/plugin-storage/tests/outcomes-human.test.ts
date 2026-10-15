import { readSessionEvent } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { MemoryCallOutcomeStore } from '../src/outcomes/index.ts';
import { applySessionEvent, emptyCallOutcome } from '../src/outcomes/projection.ts';
import {
  EXTERNAL_CALLBACKS,
  EXTERNAL_HUMAN_CALL,
  expectHumanOutcomes,
  MANAGED_HUMAN_CALL,
} from './outcomes-human-fixture.ts';

const fold = (steps: readonly (readonly [string, Record<string, unknown>])[]) =>
  steps.reduce(
    (summary, [type, payload]) =>
      applySessionEvent(summary, readSessionEvent(type, payload), 'now'),
    emptyCallOutcome('call', '2026-10-15T00:00:00.000Z'),
  );

describe('human queue outcome fold (Wave 17)', () => {
  it('starts without a human summary', () => {
    expect(emptyCallOutcome('call', '2026-10-15T00:00:00.000Z').human).toBeNull();
  });

  it('folds the managed and external flows in the memory store', async () => {
    await expectHumanOutcomes(new MemoryCallOutcomeStore(), 'ws-human');
  });

  it('never mutates the summary it folds', () => {
    let summary = emptyCallOutcome('call', '2026-10-15T00:00:00.000Z');
    for (const [type, payload] of [...EXTERNAL_HUMAN_CALL, ...EXTERNAL_CALLBACKS]) {
      const prior = summary;
      const before = structuredClone(prior);
      summary = applySessionEvent(prior, readSessionEvent(type, payload), 'now');
      expect(prior).toEqual(before);
    }
  });

  it('folds callbacks the same before or after call.outcome', () => {
    const callOutcome = EXTERNAL_HUMAN_CALL.at(-1)!;
    const before = [...EXTERNAL_HUMAN_CALL.slice(0, -1), ...EXTERNAL_CALLBACKS, callOutcome];
    const after = [...EXTERNAL_HUMAN_CALL, ...EXTERNAL_CALLBACKS];
    expect(fold(before).human).toEqual(fold(after).human);
    expect(fold(before).outcome).toBe(fold(after).outcome);
    // Callback order does not matter either.
    expect(fold([...EXTERNAL_HUMAN_CALL, ...[...EXTERNAL_CALLBACKS].reverse()]).human).toEqual(
      fold(after).human,
    );
  });

  it('keeps the summary of a managed call stable when its events replay in two batches', () => {
    const all = fold(MANAGED_HUMAN_CALL);
    expect(all.human).toMatchObject({
      requested: 1,
      connected: 1,
      outcome: 'ended',
      operator: 'u1',
    });
    const accepted = MANAGED_HUMAN_CALL.findIndex(
      ([type, payload]) => type === 'human.state' && payload.state === 'accepted',
    );
    const halves = fold(MANAGED_HUMAN_CALL.slice(0, accepted + 1));
    expect(halves.human).toMatchObject({ requested: 1, outcome: null, operator: 'u1' });
  });
});
