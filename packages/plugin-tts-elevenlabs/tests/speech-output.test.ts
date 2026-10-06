import { MULAW_8K, type SessionInput } from '@winsendotai/ovo-contracts';
import { acceleratedClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { expect, it } from 'vitest';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { BoundedSpeechScheduler } from '../../plugin-voice/src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../../plugin-voice/src/speech/media-output-v2.ts';
import { fixtureAudio, replySteps, socketOpen } from '../src/testing.ts';
import { ElevenLabsTts } from '../src/tts.ts';
import { sent, wsScript } from './support.ts';

const session: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

// LAT-5 end to end over the fixture socket: the speech scheduler speaks a reply sentence by
// sentence, the engine's output renders them in one ElevenLabs context, and every sentence still
// gets its own carrier mark and receipt carrying exactly its own audio.
it('speaks a reply in one context with one mark per sentence, then barge-in closes only it', async () => {
  const texts = ['Your EMI of 4,850 rupees is due on the fifth.', 'Shall I send a link?'];
  const net = createFixtureNet([
    wsScript([
      socketOpen(MULAW_8K),
      ...replySteps('ovo-1', texts, MULAW_8K),
      sent('ovo-2', { text: ' ' }),
      sent('ovo-2', { text: 'Sorry, go ahead. ', flush: true }),
      sent('ovo-2', { close_context: true }),
    ]),
  ]);
  const tts = new ElevenLabsTts(net, 'fixture-key');
  const clock = acceleratedClock(0);
  const carrier = createFakeCarrier({ clock });
  const output = new NativeStreamingSpeechOutput(tts, carrier.duplex, session, () => undefined);
  const speech = new BoundedSpeechScheduler(output);
  speech.configurePipeline(2);

  const receipts = await Promise.all(texts.map((text) => speech.speak(text)));
  expect(receipts).toMatchObject([
    { text: texts[0], state: 'completed' },
    { text: texts[1], state: 'completed' },
  ]);
  const audio = carrier.log.filter((entry) => entry.type === 'audio');
  const marks = carrier.log.filter((entry) => entry.type === 'mark');
  expect(marks).toHaveLength(2);
  // Each mark follows exactly its own sentence's audio, cut from the shared context by alignment.
  const before = (mark: (typeof marks)[number]) =>
    audio
      .filter((entry) => carrier.log.indexOf(entry) < carrier.log.indexOf(mark))
      .reduce((sum, entry) => sum + entry.bytes, 0);
  const first = fixtureAudio(MULAW_8K, texts[0]!, 1).byteLength;
  const second = fixtureAudio(MULAW_8K, texts[1]!, 2).byteLength;
  expect(before(marks[0]!)).toBe(first);
  expect(before(marks[1]!)).toBe(first + second);

  // The caller barges in on the next reply: its context is closed, the socket stays up.
  await speech.interrupt();
  const next = speech.speak('Sorry, go ahead.');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await speech.interrupt();
  await expect(next).resolves.toMatchObject({ state: 'interrupted' });
  expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
  output.dispose();
  await speech.dispose();
  tts.dispose();
  expect(net.pending()).toEqual([]);
  expect(net.mismatches).toEqual([]);
});
