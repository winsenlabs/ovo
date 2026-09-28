import type { CallState } from '@winsendotai/ovo-contracts';

export const TWILIO_STATUSES: Readonly<Record<string, CallState>> = Object.freeze({
  queued: 'queued',
  initiated: 'ringing',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
});

export function mapTwilioStatus(raw: string): CallState | undefined {
  return Object.hasOwn(TWILIO_STATUSES, raw) ? TWILIO_STATUSES[raw] : undefined;
}

export function mapAnsweredBy(
  raw: string | undefined,
): 'human' | 'machine' | 'unknown' | undefined {
  if (!raw) return undefined;
  if (raw === 'human') return 'human';
  if (raw.startsWith('machine_') || raw === 'machine') return 'machine';
  return 'unknown';
}
