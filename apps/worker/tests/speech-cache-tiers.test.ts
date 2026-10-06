import { describe, expect, it } from 'vitest';
import { UNROUTED_PIN_GRACE_MS, WorkerSpeechClipCache } from '../src/speech-cache-tiers.ts';
import { fixtureRelease } from './speech-cache-harness.ts';

const oldRelease = fixtureRelease({}, { id: 'release-a' });
const newRelease = fixtureRelease({}, { id: 'release-b' });
const clip = (fill: number, bytes = 4) => new Uint8Array(bytes).fill(fill);

function clock() {
  const state = { now: 1_000_000 };
  return { state, now: () => state.now };
}

describe('pinned speech clip lifetime (TTS-7)', () => {
  it('keeps a live release pinned while another release of the same agent takes calls', () => {
    const cache = new WorkerSpeechClipCache();
    expect(cache.pin(oldRelease, 'line-a', clip(1))).toBe(true);
    // A campaign still on the old release, an inbound route (or a publish warm) on the new one.
    cache.sessionStarted(newRelease);
    cache.activate(newRelease);
    cache.pin(newRelease, 'line-b', clip(2));
    expect(cache.lookup('line-a', oldRelease.workspaceId)?.tier).toBe('pinned');
    expect(cache.lookup('line-b', newRelease.workspaceId)?.tier).toBe('pinned');
  });

  it('lets go of a release once nothing routes to it and its grace has passed', () => {
    const time = clock();
    const cache = new WorkerSpeechClipCache({}, { now: time.now });
    cache.pin(oldRelease, 'line-a', clip(1));
    cache.pin(newRelease, 'line-b', clip(2));
    expect(cache.retainRouted([newRelease.id])).toEqual([]);
    expect(cache.lookup('line-a', oldRelease.workspaceId)?.tier).toBe('pinned');
    time.state.now += UNROUTED_PIN_GRACE_MS + 1;
    expect(cache.retainRouted([newRelease.id])).toEqual([oldRelease.id]);
    expect(cache.lookup('line-a', oldRelease.workspaceId)).toBeUndefined();
    expect(cache.lookup('line-b', newRelease.workspaceId)?.tier).toBe('pinned');
  });

  it('a recent session keeps an unrouted release pinned through the grace', () => {
    const time = clock();
    const cache = new WorkerSpeechClipCache({}, { now: time.now });
    cache.pin(oldRelease, 'line-a', clip(1));
    time.state.now += UNROUTED_PIN_GRACE_MS + 1;
    cache.sessionStarted(oldRelease);
    expect(cache.retainRouted([])).toEqual([]);
    expect(cache.lookup('line-a', oldRelease.workspaceId)?.tier).toBe('pinned');
  });

  it('over budget, evicts the least recently active unrouted release, never a routed one', () => {
    const time = clock();
    const cache = new WorkerSpeechClipCache({}, { pinnedMaxBytes: 8, now: time.now });
    const third = fixtureRelease({}, { id: 'release-c' });
    cache.pin(oldRelease, 'line-a', clip(1));
    time.state.now += 1;
    cache.pin(newRelease, 'line-b', clip(2));
    cache.retainRouted([oldRelease.id, newRelease.id]);
    time.state.now += 1;
    // Both pinned releases are routed: the newcomer is refused rather than evicting either.
    expect(cache.pin(third, 'line-c', clip(3))).toBe(false);
    cache.retainRouted([newRelease.id]);
    expect(cache.pin(third, 'line-c', clip(3))).toBe(true);
    expect(cache.lookup('line-a', oldRelease.workspaceId)).toBeUndefined();
    expect(cache.lookup('line-b', newRelease.workspaceId)?.tier).toBe('pinned');
    expect(cache.lookup('line-c', third.workspaceId)?.tier).toBe('pinned');
  });
});
