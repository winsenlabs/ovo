import type { Clock, UsageMeter, UsageSink } from '@winsendotai/ovo-contracts';

/** The wall clock, for hosts. Plugins receive a Clock and never read wall time directly. */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

/** `${provider}:${sessionId}:${n}` — the synthesized requestId when a provider returns none. */
export function syntheticRequestId(provider: string, sessionId: string, n: number): string {
  return `${provider}:${sessionId}:${n}`;
}

export interface UsageOnce {
  /** Emits the meters on the first call only; returns whether this call emitted. */
  emit(meters: UsageMeter | readonly UsageMeter[]): boolean;
  readonly emitted: boolean;
}

/** Usage is emitted EXACTLY once per session across finish, cancel and failure (§2.4). */
export function usageOnce(sink: UsageSink): UsageOnce {
  let emitted = false;
  return {
    get emitted() {
      return emitted;
    },
    emit(meters) {
      if (emitted) return false;
      emitted = true;
      for (const meter of Array.isArray(meters) ? meters : [meters]) {
        if (!meter.requestId) throw new TypeError('Usage meters require a requestId');
        sink(meter);
      }
      return true;
    },
  };
}
