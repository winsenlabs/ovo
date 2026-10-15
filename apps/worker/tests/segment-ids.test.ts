import type { EngineEvent, VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { limitCallSeconds, prefixEngineEvent, withSegmentIds } from '../src/segment-ids.ts';

describe('segment ids (routing design 7.4)', () => {
  it('prefixes every turn and segment id an engine event carries, and nothing else', () => {
    const events: EngineEvent[] = [
      { type: 'user.transcript', turnId: 't1', segmentId: 'u1', text: 'hi', stability: 'final' },
      { type: 'user.turn', phase: 'stopped', turnId: 't1' },
      { type: 'agent.transcript', segmentId: 'a1', text: 'hello', state: 'played' },
      { type: 'timing', key: 'llm_ttfb', turnId: 't1', atMs: 5 },
      { type: 'timing', key: 'tts_ttfb', atMs: 6 },
      {
        type: 'speech',
        evidence: {
          ...{ sequence: 1, segmentId: 'a1', text: 'hello', epoch: 0, kind: 'response' },
          ...{ phase: 'completed', at: 7, evidence: 'confirmed' },
        },
      },
      { type: 'end', reason: 'caller_hangup' },
    ];
    expect(events.map((event) => prefixEngineEvent(event, 's1:'))).toEqual([
      {
        type: 'user.transcript',
        turnId: 's1:t1',
        segmentId: 's1:u1',
        text: 'hi',
        stability: 'final',
      },
      { type: 'user.turn', phase: 'stopped', turnId: 's1:t1' },
      { type: 'agent.transcript', segmentId: 's1:a1', text: 'hello', state: 'played' },
      { type: 'timing', key: 'llm_ttfb', turnId: 's1:t1', atMs: 5 },
      { type: 'timing', key: 'tts_ttfb', atMs: 6 },
      { type: 'speech', evidence: expect.objectContaining({ segmentId: 's1:a1', text: 'hello' }) },
      { type: 'end', reason: 'caller_hangup' },
    ]);
  });

  it('wraps only what subscribers see; start, dispose and ended reach the engine itself', async () => {
    let emit!: (event: EngineEvent) => void;
    const engine = {
      start: vi.fn(async () => undefined),
      dispose: vi.fn(async () => ({ reason: 'caller_hangup', outcome: 'completed' })),
      ended: Promise.resolve({ reason: 'caller_hangup', outcome: 'completed' }),
      subscribe: (listener: (event: EngineEvent) => void) => {
        emit = listener;
        return () => undefined;
      },
      ingressStats: { acceptedFrames: 3 },
    } as unknown as VoiceSessionEngine;
    const wrapped = withSegmentIds(engine, 's1:');
    const seen: EngineEvent[] = [];
    wrapped.subscribe((event) => seen.push(event));
    emit({ type: 'user.turn', phase: 'started', turnId: 't2' });
    await wrapped.start();
    await wrapped.dispose('caller_hangup', { deadlineMs: 10 });
    expect(seen).toEqual([{ type: 'user.turn', phase: 'started', turnId: 's1:t2' }]);
    expect(engine.start).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledWith('caller_hangup', { deadlineMs: 10 });
    expect(wrapped.ended).toBe(engine.ended);
    expect(wrapped.ingressStats.acceptedFrames).toBe(3);
  });

  it('sets what is left of the time limit on the engine row, never below one second', () => {
    const rows = [
      { id: 'engine', config: { session: { maxCallSeconds: 1800, mode: 'agent' }, engine: {} } },
      { id: 'other', config: {} },
    ];
    limitCallSeconds(rows, { manifest: { id: 'engine' } }, 42);
    expect(rows[0]!.config.session).toEqual({ maxCallSeconds: 42, mode: 'agent' });
    limitCallSeconds(rows, { manifest: { id: 'engine' } }, -3);
    expect(rows[0]!.config).toMatchObject({ session: { maxCallSeconds: 1 } });
    expect(rows[1]!.config).toEqual({});
  });
});
