import {
  outcomeFor,
  type EndReason,
  type EngineEvent,
  type EngineOutcome,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';

interface LegacyEngine {
  start?(): Promise<void>;
  dispose(reason?: string): Promise<unknown>;
  ingressStats?: VoiceSessionEngine['ingressStats'];
}

/** Retain exact v1 release pins while the host observes one v2-shaped end event. */
export function adaptV1Engine(legacy: LegacyEngine): VoiceSessionEngine {
  const listeners = new Set<(event: EngineEvent) => void>();
  let finish!: (outcome: EngineOutcome) => void;
  const ended = new Promise<EngineOutcome>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<EngineOutcome> | undefined;
  return {
    start: async () => {
      await legacy.start?.();
    },
    dispose(reason: EndReason) {
      closing ??= (async () => {
        try {
          await legacy.dispose(reason);
        } finally {
          const result = { reason, outcome: outcomeFor(reason) };
          for (const listener of listeners) listener({ type: 'end', reason });
          listeners.clear();
          finish(result);
        }
        return { reason, outcome: outcomeFor(reason) };
      })();
      return closing;
    },
    ended,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ingressStats: legacy.ingressStats ?? {
      acceptedFrames: 0,
      acceptedBytes: 0,
      pendingFrames: 0,
      pendingBytes: 0,
      overflows: 0,
    },
  };
}
