import { readDurableEvent, type DurableEvent } from '@winsendotai/ovo-contracts';
export interface Projection {
  workspaceId: string;
  sessionId: string;
  lastSequence: number;
  ownershipEpoch: number;
  status: 'active' | 'ended' | 'failed';
  completedSpeech: number;
  interruptedSpeech: number;
  operations: number;
}
/** Projection recomputation is deterministic, workspace-scoped and fail-closed on sequence holes. */
export function projectSession(
  input: readonly unknown[],
  workspaceId: string,
  sessionId: string,
): Projection {
  const bySequence = new Map<number, DurableEvent>();
  const ids = new Map<string, string>();
  for (const raw of input) {
    const event = readDurableEvent(raw);
    if (event.workspaceId !== workspaceId || event.sessionId !== sessionId)
      throw new Error('Cross-session event');
    const encoded = JSON.stringify(event);
    const previous = ids.get(event.id);
    if (previous && previous !== encoded) throw new Error('Conflicting event ID');
    ids.set(event.id, encoded);
    const old = bySequence.get(event.sequence);
    if (old && JSON.stringify(old) !== encoded) throw new Error('Conflicting sequence');
    bySequence.set(event.sequence, event);
  }
  const state: Projection = {
    workspaceId,
    sessionId,
    lastSequence: -1,
    ownershipEpoch: 0,
    status: 'active',
    completedSpeech: 0,
    interruptedSpeech: 0,
    operations: 0,
  };
  for (const event of [...bySequence.values()].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sequence !== state.lastSequence + 1)
      throw new Error('Projection gap; replay durable source');
    if (event.ownershipEpoch < state.ownershipEpoch) throw new Error('Stale owner event');
    if (state.status !== 'active') throw new Error('Event after terminal session');
    if (event.sequence === 0 && event.type !== 'session.started')
      throw new Error('Missing start event');
    state.ownershipEpoch = event.ownershipEpoch;
    state.lastSequence = event.sequence;
    if (event.type === 'speech.completed') state.completedSpeech++;
    if (event.type === 'speech.interrupted') state.interruptedSpeech++;
    if (event.type === 'operation.intent') state.operations++;
    if (event.type === 'session.ended') state.status = 'ended';
    if (event.type === 'session.failed') state.status = 'failed';
  }
  return state;
}
