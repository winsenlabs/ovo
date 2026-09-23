import type { CallState } from '@winsendotai/ovo-contracts';
import type { CarrierKitContext } from './carrier-support.ts';
import { Failures, type KitCheck } from './runner.ts';

/**
 * Raw status tokens carriers are known to emit, in every spelling seen in the wild. Any token a
 * plugin's own map recognises must appear in its snapshot, so `expected: {}` can no longer assert
 * nothing: the kit probes the map itself rather than trusting the list it was handed (#F3).
 */
export const STATUS_PROBE: readonly string[] = Object.freeze([
  'queued',
  'initiated',
  'scheduled',
  'ringing',
  'ring',
  'in-progress',
  'in_progress',
  'inprogress',
  'in progress',
  'answered',
  'answer',
  'connected',
  'live',
  'bridged',
  'completed',
  'complete',
  'ended',
  'hangup',
  'busy',
  'no-answer',
  'no_answer',
  'noanswer',
  'no answer',
  'missed',
  'timeout',
  'failed',
  'failure',
  'error',
  'canceled',
  'cancelled',
  'cancel',
  'rejected',
  'terminated',
  'machine',
  'voicemail',
]);

/** A carrier must be able to report that a call is up, that it finished, and that it did not. */
const REQUIRED: readonly CallState[] = ['in_progress', 'completed'];
const UNSUCCESSFUL: readonly CallState[] = ['busy', 'no_answer', 'failed', 'canceled'];

export const CARRIER_STATUS_CHECKS: readonly KitCheck<CarrierKitContext>[] = [
  {
    name: 'the status map matches its snapshot and covers every status it can emit',
    async run(context) {
      const map = context.options.statusMap;
      if (!map) return ['no status map snapshot was supplied'];
      const f = new Failures();
      const entries = Object.entries(map.expected);
      if (!f.expect(entries.length, 'statusMap.expected is empty: it asserts nothing'))
        return f.messages;
      const safe = (raw: string): CallState | undefined | 'threw' => {
        try {
          return map.map(raw);
        } catch {
          return 'threw';
        }
      };
      for (const [raw, state] of entries) {
        const actual = safe(raw);
        f.expect(actual === state, `status ${raw} maps to ${String(actual)}, expected ${state}`);
      }
      // Anything the plugin's own map resolves must be in the snapshot, not just what it listed.
      for (const raw of STATUS_PROBE) {
        if (Object.hasOwn(map.expected, raw)) continue;
        const actual = safe(raw);
        if (actual === undefined) continue;
        f.add(
          actual === 'threw'
            ? `statusMap.map(${raw}) threw instead of returning undefined`
            : `status ${raw} maps to ${actual} but is missing from the snapshot`,
        );
      }
      const covered = new Set<CallState>(entries.map(([, state]) => state));
      for (const state of REQUIRED)
        f.expect(covered.has(state), `no raw status in the snapshot maps to ${state}`);
      f.expect(
        UNSUCCESSFUL.some((state) => covered.has(state)),
        `the snapshot maps no status to any of ${UNSUCCESSFUL.join(', ')}`,
      );
      return f.messages;
    },
  },
];
