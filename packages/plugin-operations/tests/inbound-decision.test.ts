import { describe, expect, it } from 'vitest';
import type { StreamGrant } from '@winsendotai/ovo-contracts';
import { inboundDecisionFor } from '../src/inbound-decision.ts';
import type { InboundGatewayDecision } from '../src/types.ts';

const reserved = {
  kind: 'reserved',
  admissionId: 'admission',
  jobId: 'job',
  sessionId: 'session',
  workerId: 'worker',
  workerEndpoint: 'wss://worker.test',
  releaseId: 'release',
  routeVersion: 1,
} as const;
const grant: StreamGrant = {
  kind: 'stream',
  mediaUrl: 'wss://gateway.test/carriers/fixture/binding/media',
  routeParams: { sid: 'session', rt: 'token' },
  resumeUrl: 'https://gateway.test/resume',
  statusUrl: 'https://gateway.test/status',
};
const wait = {
  kind: 'wait',
  admissionId: 'admission',
  announcement: 'Please wait',
  expiresAt: new Date('2026-09-23T00:00:00Z'),
  pollAfterMs: 1001,
} as const;
const callback = {
  kind: 'callback',
  admissionId: 'admission',
  state: 'prompt',
  announcement: 'Press one',
} as const;
const busy = { kind: 'busy', admissionId: 'admission', reason: 'at capacity' } as const;
const human = {
  kind: 'human',
  admissionId: 'admission',
  target: '+14155550199',
  announcement: 'Connecting',
} as const;

// These are compiled by the full typecheck. A wrong context must fail before runtime.
if (false) {
  // @ts-expect-error reserved requires a grant
  inboundDecisionFor(reserved, { kind: 'reserved' });
  // @ts-expect-error wait requires a retry URL
  inboundDecisionFor(wait, { kind: 'wait' });
  // @ts-expect-error callback requires timeoutSeconds
  inboundDecisionFor(callback, { kind: 'callback', digitsUrl: 'https://gateway.test/digits' });
  // @ts-expect-error kind must match the decision
  inboundDecisionFor(wait, { kind: 'busy' });
}

describe('inboundDecisionFor', () => {
  it('maps a supplied StreamGrant without minting or altering its route data', () => {
    expect(inboundDecisionFor(reserved, { kind: 'reserved', grant })).toEqual({
      kind: 'connect',
      mediaUrl: grant.mediaUrl,
      routeParams: grant.routeParams,
      resumeUrl: grant.resumeUrl,
      statusUrl: grant.statusUrl,
    });
  });
  it.each([
    [0, 1],
    [1, 1],
    [999, 1],
    [1000, 1],
    [1001, 2],
    [5000, 5],
  ])('rounds wait %i ms to %i second(s), minimum one', (pollAfterMs, pauseSeconds) => {
    expect(
      inboundDecisionFor(
        { ...wait, pollAfterMs },
        { kind: 'wait', retryUrl: 'https://gateway.test/retry', announce: false },
      ),
    ).toEqual({
      kind: 'wait',
      message: 'Please wait',
      announce: false,
      pauseSeconds,
      retryUrl: 'https://gateway.test/retry',
    });
  });
  it('maps callback, busy and human fields directly', () => {
    expect(
      inboundDecisionFor(callback, {
        kind: 'callback',
        digitsUrl: 'https://gateway.test/digits',
        timeoutSeconds: 8,
      }),
    ).toEqual({
      kind: 'callback-offer',
      prompt: 'Press one',
      digitsUrl: 'https://gateway.test/digits',
      timeoutSeconds: 8,
    });
    expect(inboundDecisionFor(busy, { kind: 'busy' })).toEqual({
      kind: 'busy',
      reason: 'at capacity',
    });
    expect(inboundDecisionFor(human, { kind: 'human' })).toEqual({
      kind: 'human',
      e164: '+14155550199',
      message: 'Connecting',
    });
  });
  it.each([
    ['queued', 'Your callback request has been queued.'],
    ['declined', 'No callback was requested.'],
    ['suppressed', 'A callback cannot be scheduled for this number.'],
  ] as const)('hangs up a settled %s callback without re-offering consent', (state, message) => {
    expect(
      inboundDecisionFor(
        { ...callback, state },
        { kind: 'callback', digitsUrl: 'https://gateway.test/digits', timeoutSeconds: 8 },
      ),
    ).toEqual({ kind: 'hangup', message });
  });
  it('throws loudly for missing or mismatched JS context instead of downgrading', () => {
    const call = (decision: InboundGatewayDecision, context: unknown) =>
      (inboundDecisionFor as (decision: InboundGatewayDecision, context: unknown) => unknown)(
        decision,
        context,
      );
    expect(() => call(reserved, { kind: 'reserved' })).toThrow('StreamGrant');
    expect(() =>
      call(reserved, {
        kind: 'reserved',
        grant: { kind: 'stream', mediaUrl: 'wss://gateway.test', routeParams: {} },
      }),
    ).toThrow('sid and rt');
    expect(() =>
      call(reserved, {
        kind: 'reserved',
        grant: { ...grant, routeParams: { sid: 'other', rt: 'token' } },
      }),
    ).toThrow('sid must match sessionId');
    expect(() => call(wait, { kind: 'wait' })).toThrow('retryUrl');
    expect(() => call(wait, { kind: 'wait', retryUrl: '' })).toThrow('retryUrl');
    expect(() => call(wait, { kind: 'busy' })).toThrow('matching context');
    expect(() =>
      call(wait, { kind: 'wait', retryUrl: 'https://gateway.test/retry', announce: 'yes' }),
    ).toThrow('announce must be boolean');
    expect(() =>
      call(
        { ...wait, pollAfterMs: Number.NaN },
        { kind: 'wait', retryUrl: 'https://gateway.test/retry' },
      ),
    ).toThrow('finite pollAfterMs');
    expect(() =>
      call({ ...wait, announcement: undefined } as never, {
        kind: 'wait',
        retryUrl: 'https://gateway.test/retry',
      }),
    ).toThrow('announcement');
    expect(() =>
      call(callback, { kind: 'callback', digitsUrl: 'https://gateway.test/digits' }),
    ).toThrow('timeoutSeconds');
    expect(() => call(callback, { kind: 'callback', digitsUrl: '', timeoutSeconds: 8 })).toThrow(
      'digitsUrl',
    );
    expect(() =>
      call({ ...callback, announcement: undefined } as never, {
        kind: 'callback',
        digitsUrl: 'https://gateway.test/digits',
        timeoutSeconds: 8,
      }),
    ).toThrow('announcement');
    expect(() => call({ ...busy, reason: undefined } as never, { kind: 'busy' })).toThrow('reason');
    expect(() => call({ ...human, target: undefined } as never, { kind: 'human' })).toThrow(
      'target',
    );
    expect(() => call({ ...human, announcement: undefined } as never, { kind: 'human' })).toThrow(
      'announcement',
    );
    expect(() =>
      call({ ...callback, state: 'unknown' } as never, {
        kind: 'callback',
        digitsUrl: 'https://gateway.test/digits',
        timeoutSeconds: 8,
      }),
    ).toThrow('Unsupported inbound callback state');
    expect(() => call({ kind: 'unknown' } as never, { kind: 'unknown' })).toThrow(
      'Unsupported inbound decision kind',
    );
  });
});
