import type { InferenceRequest } from '@winsendotai/ovo-contracts';
import { PlaybackConversation } from './history.ts';

type Message = NonNullable<InferenceRequest['history']>[number];

/**
 * The history `conversation.user(next)` would return right now, without recording anything: what
 * a decision on a partial transcript must see to match the turn's own (LAT-4).
 *
 * `PlaybackConversation` has no read-only accessor, and `history.ts` belongs to no lane this wave,
 * so this asks a structured copy instead. Its state is plain data (arrays, a Set, numbers), which
 * `structuredClone` copies exactly. The integrator may replace this with a `peek()` on the class.
 */
export function peekHistory(conversation: PlaybackConversation): Message[] {
  const copy = Object.setPrototypeOf(
    structuredClone({ ...conversation }),
    PlaybackConversation.prototype,
  ) as PlaybackConversation;
  return copy.user('');
}
