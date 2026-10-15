import { readSessionEvent } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { MemoryCallOutcomeStore } from '../src/outcomes/index.ts';
import { applySessionEvent, emptyCallOutcome } from '../src/outcomes/projection.ts';
import { expectTransferOutcomes, TRANSFERRED_CALL } from './outcomes-transfer-fixture.ts';

describe('transfer outcome fold (Wave 16)', () => {
  it('starts with no segments and zero transfers', () => {
    expect(emptyCallOutcome('call', '2026-10-15T00:00:00.000Z')).toMatchObject({
      segments: [],
      transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
    });
  });

  it('folds segments, transfers and the fallback agent in the memory store', async () => {
    await expectTransferOutcomes(new MemoryCallOutcomeStore(), 'ws-transfer');
  });

  it('never mutates the summary it folds', () => {
    let summary = emptyCallOutcome('call', '2026-10-15T00:00:00.000Z');
    for (const [type, payload] of TRANSFERRED_CALL) {
      const prior = summary;
      const before = structuredClone(prior);
      summary = applySessionEvent(prior, readSessionEvent(type, payload), 'now');
      expect(prior).toEqual(before);
    }
    const again = TRANSFERRED_CALL.reduce(
      (folded, [type, payload]) =>
        applySessionEvent(folded, readSessionEvent(type, payload), 'now'),
      emptyCallOutcome('call', '2026-10-15T00:00:00.000Z'),
    );
    expect(again).toEqual(summary);
    const segmentEnded = TRANSFERRED_CALL.findIndex(([type]) => type === 'segment.ended');
    const partial = TRANSFERRED_CALL.slice(0, segmentEnded).reduce(
      (folded, [type, payload]) =>
        applySessionEvent(folded, readSessionEvent(type, payload), 'now'),
      emptyCallOutcome('call', 'now'),
    );
    const next = applySessionEvent(
      partial,
      readSessionEvent(...TRANSFERRED_CALL[segmentEnded]!),
      'now',
    );
    expect(partial.segments[1]!.durationMs).toBeNull();
    expect(next.segments[1]!.durationMs).toBe(61_000);
  });
});
