import type { InferenceRequest } from '@winsendotai/ovo-contracts';
import type { PlaybackConversation } from './history.ts';

type Message = NonNullable<InferenceRequest['history']>[number];

/**
 * The history `conversation.user(next)` would return right now, without recording anything: what
 * a decision on a partial transcript must see to match the turn's own (LAT-4).
 */
export function peekHistory(conversation: PlaybackConversation): Message[] {
  return conversation.peek().history;
}
