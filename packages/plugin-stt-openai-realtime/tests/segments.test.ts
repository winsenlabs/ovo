import { describe, expect, it } from 'vitest';
import type { SttEvent } from '@winsendotai/ovo-contracts';
import { RealtimeSegments } from '../src/segments.ts';

function track() {
  const events: string[] = [];
  const segments = new RealtimeSegments((event: SttEvent) =>
    events.push(
      event.type === 'transcript'
        ? `${event.segment.segmentId}:${event.segment.stability}:${event.segment.text}`
        : event.type,
    ),
  );
  return { events, segments };
}

describe('realtime transcript segments', () => {
  it('locks a completion that arrives before its commit once, never again on the next', () => {
    const { events, segments } = track();
    segments.completed('i1', 'first');
    segments.committed('i1');
    segments.committed('i2');
    segments.completed('i2', 'second');
    expect(events).toEqual(['i1:final:first', 'end-of-turn', 'i2:final:second', 'end-of-turn']);
  });
});
