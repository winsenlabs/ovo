import type { EngineEvent } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { attachRecordingEvidence } from '../src/recording-evidence.ts';

describe('v2 engine recording evidence bridge', () => {
  it('forwards speech evidence, ignores unrelated events, and detaches on close', () => {
    const listeners = new Set<(event: EngineEvent) => void>();
    const captured: unknown[] = [];
    const detach = vi.fn();
    const capture = {
      attachEvidence: ({
        subscribe,
      }: {
        subscribe: (listener: (value: unknown) => void) => () => void;
      }) => {
        const stop = subscribe((value) => captured.push(value));
        return () => {
          stop();
          detach();
        };
      },
    };
    const engine = {
      subscribe: (listener: (event: EngineEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emit = (event: EngineEvent) => {
      for (const listener of listeners) listener(event);
    };
    const stop = attachRecordingEvidence(capture as never, engine);
    const evidence = { segmentId: 'segment-1', phase: 'generated' };
    emit({ type: 'speech', evidence } as EngineEvent);
    emit({ type: 'end', reason: 'caller_hangup' });
    expect(captured).toEqual([evidence]);
    stop();
    emit({ type: 'speech', evidence } as EngineEvent);
    expect(captured).toEqual([evidence]);
    expect(detach).toHaveBeenCalledOnce();
  });
});
