import type { EngineEvent, VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { patchEngineSession } from './session-graph-bindings.ts';

/** How a routed call's segment differs from its release's own graph (design 7.3, 7.4). */
export interface SegmentGraphShape {
  /** Replaces the release's behaviour: the router's, on segment 0. */
  behavior?: { definition: PluginDefinition; config: Record<string, unknown> };
  /** Host services the replacement needs (routing, segment handoff). */
  services?: readonly PluginDefinition[];
  /** `s1:` on segment 1: its turn and segment ids never collide with an earlier segment's. */
  idPrefix?: string;
  /** What is left of the call's time limit when the segment starts. */
  maxCallSeconds?: number;
}

/**
 * A routed call's later segments restart their engine's turn and speech counters, so `turn-1` of
 * the agent would collide with the router's `turn-1` in the call's telemetry, recording evidence
 * and outcome rows. Their ids carry the segment (`s1:turn-1`) before any writer sees them.
 */
export function prefixEngineEvent<Event extends EngineEvent>(event: Event, prefix: string): Event {
  const id = (value: string) => `${prefix}${value}`;
  switch (event.type) {
    case 'speech':
      return { ...event, evidence: { ...event.evidence, segmentId: id(event.evidence.segmentId) } };
    case 'user.transcript':
      return { ...event, turnId: id(event.turnId), segmentId: id(event.segmentId) };
    case 'user.turn':
      return { ...event, turnId: id(event.turnId) };
    case 'agent.transcript':
      return { ...event, segmentId: id(event.segmentId) };
    case 'timing':
      return {
        ...event,
        ...(event.turnId !== undefined ? { turnId: id(event.turnId) } : {}),
        ...(event.segmentId !== undefined ? { segmentId: id(event.segmentId) } : {}),
      };
    default:
      return event;
  }
}

/** The engine as its subscribers see it: every event's ids prefixed. */
export function withSegmentIds(engine: VoiceSessionEngine, prefix: string): VoiceSessionEngine {
  return {
    start: () => engine.start(),
    dispose: (reason, opts) => engine.dispose(reason, opts),
    get ended() {
      return engine.ended;
    },
    get ingressStats() {
      return engine.ingressStats;
    },
    subscribe: (listener) =>
      engine.subscribe((event) => listener(prefixEngineEvent(event, prefix))),
  };
}

/** Sets the engine row's call time limit (seconds, at least one). */
export function limitCallSeconds(
  rows: { id: string; config?: Record<string, unknown> }[],
  engine: { manifest: { id: string } },
  seconds: number,
): void {
  patchEngineSession(rows, engine, { maxCallSeconds: Math.max(1, seconds) });
}
