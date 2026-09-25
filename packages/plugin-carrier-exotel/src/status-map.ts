import type { CallState } from '@winsendotai/ovo-contracts';

/** Tokens documented by Exotel's Call Details and StatusCallback pages. */
export const EXOTEL_STATUSES: Readonly<Record<string, CallState>> = {
  queued: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
};

export function mapExotelStatus(value: string): CallState | undefined {
  return EXOTEL_STATUSES[value.toLowerCase()];
}
