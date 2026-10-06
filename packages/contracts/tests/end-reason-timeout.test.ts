import { describe, expect, it } from 'vitest';
import { outcomeFor, timeoutOf, timeoutReason } from '../src/index.ts';

describe('timeout end reasons (OBS-9)', () => {
  it('names the stage and provider, and still fails the call', () => {
    expect(timeoutReason('route_resolve')).toBe('error:timeout:route_resolve');
    expect(timeoutReason('stt', 'stt/assemblyai')).toBe('error:timeout:stt:stt/assemblyai');
    expect(outcomeFor(timeoutReason('worker_dial'))).toBe('failed');
  });

  it('leaves out a provider name that is not a plain identifier', () => {
    expect(timeoutReason('tts', 'bad name: x')).toBe('error:timeout:tts');
  });

  it.each([
    ['error:timeout:worker_dial', { stage: 'worker_dial' }],
    ['error:timeout:llm:llm/acme', { stage: 'llm', provider: 'llm/acme' }],
    ['error:carrier start timeout', { stage: 'carrier_start' }],
    ['error:media idle timeout', { stage: 'media_idle' }],
    [
      'error:session-open-failed:compose:stt/acme: connect timeout',
      { stage: 'session_open', provider: 'stt/acme' },
    ],
    ['error:session-open-failed:compose:stt handshake timed out', { stage: 'session_open' }],
  ])('reads %s', (reason, expected) => {
    expect(timeoutOf(reason)).toEqual(expected);
  });

  it.each([
    'caller_hangup',
    'error:stt',
    'error:session-open-failed:compose:stt/acme: 401 rejected',
    'error:timeout:',
    'error:timeouts are fine',
  ])('finds no timeout in %s', (reason) => {
    expect(timeoutOf(reason)).toBeUndefined();
  });
});
