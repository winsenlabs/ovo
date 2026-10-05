import { outcomeFor } from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import { asEndReason } from '../src/duplex-shims.ts';

it.each(['carrier stream-ended', 'carrier caller-hangup', 'carrier unknown'])(
  'classifies the gateway close %j as a caller hang-up, not a failure',
  (reason) => {
    // Regression: a Twilio stop reached the worker as `carrier stream-ended`, became
    // `error:carrier stream-ended` and recorded every normal hang-up as session.failed.
    expect(asEndReason(reason)).toBe('caller_hangup');
    expect(outcomeFor(asEndReason(reason))).toBe('caller_ended');
  },
);

it('still classifies a carrier transport failure as an error', () => {
  expect(asEndReason('carrier route failed')).toBe('error:carrier route failed');
});
