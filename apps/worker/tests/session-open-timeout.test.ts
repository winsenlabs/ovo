import { timeoutOf } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { sessionOpenFailure, sessionOpenTimedOut } from '../src/session-open-failure.ts';

describe('session-open timeout reasons (OBS-9)', () => {
  it('marks a timeout by name whose message does not say so', () => {
    const vendor = Object.assign(new Error('socket closed'), {
      name: 'TimeoutError',
      provider: 'acme',
      kind: 'stt',
    });
    const reason = sessionOpenFailure('compose', new Error('engine start', { cause: vendor }));
    expect(reason).toBe('error:session-open-failed:compose:stt/acme: timeout: engine start');
    expect(timeoutOf(reason)).toEqual({ stage: 'session_open', provider: 'stt/acme' });
  });

  it('recognises socket timeout codes in the cause chain', () => {
    const cause = Object.assign(new Error('connect failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(sessionOpenTimedOut(new Error('open', { cause }))).toBe(true);
    expect(sessionOpenTimedOut(new Error('401 rejected'))).toBe(false);
  });

  it('leaves a message that already names the timeout, and other failures, unchanged', () => {
    const named = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' });
    expect(sessionOpenFailure('compose', named)).toBe(
      'error:session-open-failed:compose:connect ETIMEDOUT 10.0.0.1:443',
    );
    expect(sessionOpenFailure('admission', new Error('budget'))).toBe(
      'error:session-open-failed:admission:budget',
    );
  });
});
