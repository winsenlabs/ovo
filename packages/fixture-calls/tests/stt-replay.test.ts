import { describe, expect, it } from 'vitest';
import { MULAW_8K, type SttEvent } from '@winsendotai/ovo-contracts';
import {
  FakeClock,
  fixtureTemplates,
  fixtureSttPlugin,
  withEgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { FixtureSpeechToText } from '../../conformance/src/drivers/fixture-stt.ts';
import {
  DeepgramStt,
  fixtureTemplates as deepgramTemplates,
} from '../../plugin-stt-deepgram/src/index.ts';
import { planSttReplay } from '../src/stt-replay-plan.ts';
import { createSttReplayNet } from '../src/stt-replay-net.ts';

const input = {
  format: MULAW_8K,
  language: 'en',
  sessionId: 'replay',
  turns: [
    { atMs: 0, say: 'Please do that.', silenceMs: 100 },
    { atMs: 1200, say: 'yes', silenceMs: 200 },
  ],
};

for (const provider of ['generic', 'deepgram'] as const) {
  it(`gates ${provider} final yes until actual caller audio after a delayed confirmation`, async () => {
    await withEgressSentinel(
      async () => {
        const clock = new FakeClock();
        const template =
          provider === 'generic'
            ? fixtureTemplates[fixtureSttPlugin.manifest.id]!
            : deepgramTemplates['@winsendotai/ovo-provider-deepgram-stt']!;
        const replay = createSttReplayNet(planSttReplay(template, input), clock);
        const service =
          provider === 'generic'
            ? new FixtureSpeechToText(replay.port, { clock })
            : new DeepgramStt(replay.port, 'fixture-key', { model: 'nova-3' });
        const events: SttEvent[] = [];
        const session = await service.start({
          sessionId: 'replay',
          format: MULAW_8K,
          language: 'en',
          signal: new AbortController().signal,
          onEvent: (event) => events.push(event),
          onUsage: () => undefined,
        });
        const finals = () =>
          events
            .flatMap((event) =>
              event.type === 'transcript' && event.segment.stability === 'final'
                ? [event.segment.text]
                : [],
            )
            .filter(Boolean);
        replay.release(0);
        await session.write(new Uint8Array(800));
        await clock.advanceAsync(10_000);
        expect(finals()).toEqual(['Please do that.']);
        expect(() => replay.assertComplete()).toThrow();
        replay.release(1);
        await session.write(new Uint8Array(800));
        await clock.advanceAsync(0);
        expect(finals()).toEqual(['Please do that.', 'yes']);
        await session.finish();
        expect(() => replay.assertComplete()).not.toThrow();
      },
      { allowLoopback: false },
    );
  });
}

describe('STT replay template contract backstop', () => {
  it('refuses a template that rewrites prior utterances rather than appending their server frames', () => {
    const template = fixtureTemplates[fixtureSttPlugin.manifest.id]!;
    expect(() =>
      planSttReplay((value) => {
        const scripts = template(value);
        scripts[0]!.retrieved = value.turns.filter((turn) => turn.say).length.toString();
        return scripts;
      }, input),
    ).toThrow('fixture_unavailable: STT template cannot isolate caller-turn replay');
  });
});

for (const provider of ['generic', 'deepgram'] as const) {
  for (const delivered of [false, true]) {
    it(`${provider} only accepts scripted cancellation after every caller turn is delivered (${delivered})`, async () => {
      const clock = new FakeClock();
      const template =
        provider === 'generic'
          ? fixtureTemplates[fixtureSttPlugin.manifest.id]!
          : deepgramTemplates['@winsendotai/ovo-provider-deepgram-stt']!;
      const replay = createSttReplayNet(planSttReplay(template, input), clock);
      const service =
        provider === 'generic'
          ? new FixtureSpeechToText(replay.port, { clock })
          : new DeepgramStt(replay.port, 'fixture-key', { model: 'nova-3' });
      const finals: string[] = [];
      const session = await service.start({
        sessionId: 'replay',
        format: MULAW_8K,
        language: 'en',
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (
            event.type === 'transcript' &&
            event.segment.stability === 'final' &&
            event.segment.text
          )
            finals.push(event.segment.text);
        },
        onUsage: () => undefined,
      });
      replay.release(0);
      await session.write(new Uint8Array(800));
      await clock.advanceAsync(0);
      if (delivered) {
        replay.release(1);
        await clock.advanceAsync(0);
      }
      replay.callerHangup();
      await session.cancel('caller_hangup');
      await clock.advanceAsync(0);
      expect(finals).toEqual(delivered ? ['Please do that.', 'yes'] : ['Please do that.']);
      if (delivered) expect(() => replay.assertComplete()).not.toThrow();
      else expect(() => replay.assertComplete()).toThrow();
    });
  }
}

it('retains initial provider messages until a message listener attaches', async () => {
  const clock = new FakeClock();
  const template = (value: typeof input) => [
    {
      host: 'fixture.invalid',
      source: 'https://fixture.invalid/stt',
      retrieved: '2026-09-26',
      steps: [
        { expect: 'ws-open' as const, url: 'wss://fixture.invalid/stt' },
        { send: 'ready' },
        ...value.turns.filter((turn) => turn.say).map((turn) => ({ send: turn.say! })),
      ],
    },
  ];
  const replay = createSttReplayNet(planSttReplay(template as never, input), clock);
  const socket = replay.port.websocket('wss://fixture.invalid/stt');
  await clock.advanceAsync(0);
  const received: (string | Uint8Array)[] = [];
  socket.on('message', (value) => received.push(value));
  await clock.advanceAsync(0);
  expect(received).toEqual(['ready']);
  replay.release(0);
  replay.release(1);
  socket.close(1000);
  expect(() => replay.assertComplete()).not.toThrow();
});
