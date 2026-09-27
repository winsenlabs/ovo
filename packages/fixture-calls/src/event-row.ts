import type { EngineEvent } from '@winsendotai/ovo-contracts';
import type { FixtureCallEvent } from './types.ts';

/** Preserve engine events for inspection and flat transcript fields for recording exports. */
export function fixtureEventAudit(row: FixtureCallEvent): {
  type: string;
  payload: Record<string, unknown>;
} {
  const event: EngineEvent = row.event;
  const type =
    event.type === 'user.transcript'
      ? event.stability === 'final'
        ? 'transcript.accepted'
        : 'transcript.revision'
      : event.type === 'agent.transcript'
        ? event.state === 'played'
          ? 'speech.completed'
          : 'transcript.agent'
        : 'engine.event';
  const transcript =
    event.type === 'user.transcript' || event.type === 'agent.transcript'
      ? {
          text: event.text,
          speaker: event.type === 'user.transcript' ? 'customer' : 'agent',
          segmentId: event.segmentId,
          ...(event.type === 'user.transcript'
            ? { turnId: event.turnId, isFinal: event.stability === 'final' }
            : { state: event.state }),
        }
      : {};
  return { type, payload: { event, atMs: row.atMs, ...transcript } };
}
