import {
  MULAW_8K,
  type MediaDuplex,
  type SessionInput,
  type TurnDetectorFactory,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';

it('keeps the bot speaking until every pipelined segment in its epoch finishes', async () => {
  const observed: VoiceEvent[] = [];
  const marks: string[] = [];
  const played = new Set<(name: string) => void>();
  const media: MediaDuplex = {
    sessionId: 'fixture',
    carrierId: 'fixture',
    format: MULAW_8K,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    bufferedBytes: 0,
    async sendAudio() {},
    async mark(name) {
      marks.push(name);
    },
    async clear() {},
    onAudio: () => () => undefined,
    onPlayed(listener) {
      played.add(listener);
      return () => played.delete(listener);
    },
    onCleared: () => () => undefined,
    onDtmf: () => () => undefined,
    onClose: () => () => undefined,
    async close() {},
  };
  const detector: TurnDetectorFactory = {
    create: () => ({
      observe: (event) => observed.push(event),
      on: () => () => undefined,
      dispose() {},
    }),
  };
  const session: SessionInput = {
    mode: 'faq',
    language: 'en-US',
    inputEnabled: false,
    variables: {},
    maxCallSeconds: 60,
    acknowledgements: [],
  };
  const output = new NativeStreamingSpeechOutput(
    {
      capabilities: {
        outputFormats: [MULAW_8K],
        languages: ['en-US'],
        interim: false,
        wordTimestamps: false,
        turnSignals: [],
        forceEndpoint: false,
      },
      cacheIdentity: () => ({ provider: 'fixture', model: 'fixture', voice: '', revision: '1' }),
      async *synthesize() {
        yield new Uint8Array(160);
      },
    },
    media,
    session,
    () => undefined,
    { markTimeoutMs: 1000 },
  );
  const scheduler = new BoundedSpeechScheduler(output);
  const engine = new NativeVoiceSessionEngine({
    behavior: { respond: async () => '' },
    scheduler,
    media,
    turnDetector: detector,
    session,
  });
  try {
    await engine.start();
    const first = scheduler.speak('first', { kind: 'confirmation' });
    const second = scheduler.speak('second', { kind: 'confirmation' });
    await until(() => marks.length === 2);
    for (const listener of played) listener(marks[0]!);
    await first;
    expect(observed.filter((event) => event.type === 'bot.stopped')).toHaveLength(0);
    expect(observed.filter((event) => event.type === 'bot.started')).toHaveLength(1);
    for (const listener of played) listener(marks[1]!);
    await second;
    expect(observed.filter((event) => event.type === 'bot.stopped')).toHaveLength(1);
  } finally {
    await engine.dispose('drain');
    output.dispose();
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('speech marks not sent');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
