import {
  MULAW_8K,
  type NetFixtureScript,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { SarvamStt } from '../src/stt.ts';

const sttScript = (steps: NetFixtureScript['steps']): NetFixtureScript[] => [
  {
    steps,
    host: 'api.sarvam.ai',
    retrieved: '2026-09-29',
    source: 'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming',
  },
];

const sttInput = (events: SttEvent[], usage: UsageMeter[]) => ({
  onUsage: (meter: UsageMeter) => usage.push(meter),
  onEvent: (event: SttEvent) => events.push(event),
  signal: new AbortController().signal,
  language: 'hi-IN',
  format: MULAW_8K,
  sessionId: 'sarvam-test',
});

describe('Sarvam structured STT errors', () => {
  it('continues after a nonfatal STT error and bills the completed session once', async () => {
    const net = createFixtureNet(
      sttScript([
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
          headers: { 'api-subscription-key': 'fixture-key' },
        },
        { send: JSON.stringify({ event: 'session.begin', session_id: 'provider-session' }) },
        {
          send: JSON.stringify({
            event: 'error',
            code: 'recoverable',
            is_fatal: false,
            message: 'one frame was ignored',
          }),
        },
        { expect: 'ws-send', match: 'json', where: { event: 'audio_input' } },
        { send: JSON.stringify({ event: 'transcript.final', text: 'recovered' }) },
        { expect: 'ws-send', match: 'json', where: { event: 'end' } },
        { send: JSON.stringify({ event: 'session.end', audio_duration_s: 0.1 }) },
        { close: { code: 1000 } },
      ]),
    );
    const events: SttEvent[] = [];
    const usage: UsageMeter[] = [];
    const session = await new SarvamStt(net, 'fixture-key').start(sttInput(events, usage));
    await session.write(new Uint8Array(800));
    await session.finish();
    expect(events).toMatchObject([
      { type: 'transcript', segment: { text: 'recovered', stability: 'final' } },
      { type: 'end-of-turn' },
    ]);
    expect(usage).toMatchObject([
      { requestId: 'provider-session', quantity: '0.1', state: 'reconciled' },
    ]);
    net.assertComplete();
  });

  it.each([true, undefined])(
    'stops when is_fatal=%s and emits estimated usage once',
    async (isFatal) => {
      const net = createFixtureNet(
        sttScript([
          {
            expect: 'ws-open',
            url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
            headers: { 'api-subscription-key': 'fixture-key' },
          },
          { send: JSON.stringify({ event: 'session.begin' }) },
          {
            send: JSON.stringify({
              event: 'error',
              code: 'fatal',
              ...(isFatal === undefined ? {} : { is_fatal: isFatal }),
              message: 'provider stopped',
            }),
          },
        ]),
      );
      const usage: UsageMeter[] = [];
      const session = await new SarvamStt(net, 'fixture-key').start(sttInput([], usage));
      await expect(session.write(new Uint8Array(800))).rejects.toThrow('no longer writable');
      await expect(session.finish()).rejects.toMatchObject({
        name: 'SarvamSttError',
        code: 'fatal',
        retryable: false,
      });
      await session.cancel('after fatal');
      expect(usage).toMatchObject([{ requestId: 'sarvam:sarvam-test:1', state: 'estimated' }]);
      net.assertComplete();
    },
  );
});
