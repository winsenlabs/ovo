import type { SttEvent } from '@winsendotai/ovo-contracts';

export function isProviderEnd(event: SttEvent): boolean {
  return event.type === 'end-of-turn' || event.type === 'utterance-end';
}
