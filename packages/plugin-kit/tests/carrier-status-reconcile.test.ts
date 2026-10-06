import { outcomeFor } from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import { asEndReason } from '../src/duplex-shims.ts';

// OBS-1 reconcile: when the carrier's status callback (`completed`) lands before the media stream
// stop, the worker closes the session with `carrier terminal: <route status>`. That used to become
// `error:carrier-terminal:completed`, so a normal hang-up was recorded as a failed call.
it('treats a completed status callback as the caller hanging up', () => {
  expect(asEndReason('carrier terminal: completed')).toBe('caller_hangup');
  expect(outcomeFor(asEndReason('carrier terminal: completed'))).toBe('caller_ended');
});

it.each(['failed', 'busy', 'no_answer', 'cancelled'])(
  'keeps a %s status callback a carrier error',
  (status) => {
    expect(asEndReason(`carrier terminal: ${status}`)).toBe(`error:carrier-terminal:${status}`);
    expect(outcomeFor(asEndReason(`carrier terminal: ${status}`))).toBe('failed');
  },
);
