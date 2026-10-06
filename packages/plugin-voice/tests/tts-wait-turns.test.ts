import { expect, it } from 'vitest';
import {
  MULAW_8K,
  type EngineEvent,
  type SpeechToText,
  type SttEvent,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';

/**
 * AGT-9 with AGT-10, through the engine: "yes" said while the agent's reply is still being
 * synthesised is not a backchannel over the agent (it has not said anything yet). It supersedes
 * the stale reply, whose audio never reaches the carrier, and one reply answers both utterances.
 */
it('answers "yes" said during the TTS wait together with the words before it', async () => {
  const carrier = createFakeCarrier({ playback: 'manual' });
  const played = new Set<(name: string) => void>();
  const marks: string[] = [];
  const media = {
    ...carrier.duplex,
    onPlayed(fn: (name: string) => void) {
      played.add(fn);
      return () => played.delete(fn);
    },
    async mark(name: string) {
      marks.push(name);
    },
  };
  let transcribe!: (event: SttEvent) => void;
  const stt: SpeechToText = {
    capabilities: {
      inputFormats: [MULAW_8K],
      languages: ['en-IN'],
      interim: true,
      wordTimestamps: false,
      turnSignals: ['end-of-turn'],
      forceEndpoint: false,
    },
    async start(input) {
      transcribe = input.onEvent;
      return { async write() {}, async finish() {}, async cancel() {} };
    },
  };
  const session = {
    mode: 'agent' as const,
    language: 'en-IN',
    inputEnabled: true,
    initialInput: 'hello',
    variables: {},
    maxCallSeconds: 60,
    acknowledgements: [],
  };
  const synthesised: string[] = [];
  const output = new NativeStreamingSpeechOutput(
    {
      capabilities: {
        outputFormats: [MULAW_8K],
        languages: ['en-IN'],
        interim: false,
        wordTimestamps: false,
        turnSignals: [],
        forceEndpoint: false,
      },
      cacheIdentity: () => ({ provider: 'fixture', model: 'fixture', voice: '', revision: '1' }),
      async *synthesize({ text, signal }) {
        synthesised.push(text);
        // The stale reply's synthesis is still running when the caller speaks again.
        if (text === 'You got it.')
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
        if (!signal.aborted) yield new Uint8Array(160);
      },
    },
    media,
    session,
    () => undefined,
  );
  const scheduler = new BoundedSpeechScheduler(output);
  const inputs: string[] = [];
  const events: EngineEvent[] = [];
  const engine = new NativeVoiceSessionEngine({
    behavior: {
      respond: async () => '',
      async *respondStream(input) {
        inputs.push(input);
        yield input === 'I got the message' ? 'You got it.' : `Reply to ${input}.`;
      },
    },
    scheduler,
    media,
    stt,
    session,
  });
  engine.subscribe((event) => events.push(event));
  const say = (id: string, text: string) => {
    transcribe({
      type: 'transcript',
      segment: { segmentId: id, revision: 1, text, stability: 'final' },
    });
    transcribe({ type: 'end-of-turn' });
  };
  try {
    await engine.start();
    await expect.poll(() => marks.length).toBe(1);
    for (const fn of played) fn(marks[0]!);
    await expect.poll(() => inputs).toEqual(['hello']);
    say('a', 'I got the message');
    await expect.poll(() => synthesised).toContain('You got it.');
    say('b', 'yes');
    await expect
      .poll(() => inputs)
      .toEqual(['hello', 'I got the message', 'I got the message yes']);
    await expect.poll(() => marks.length).toBe(2);
    expect(events.filter((event) => event.type === 'interrupt')).toEqual([]);
    const audible = events.flatMap((event) =>
      event.type === 'speech' && event.evidence.phase === 'sent' ? [event.evidence.text] : [],
    );
    expect(audible).toEqual(['Reply to hello.', 'Reply to I got the message yes.']);
  } finally {
    await engine.dispose('drain');
    output.dispose();
  }
});
