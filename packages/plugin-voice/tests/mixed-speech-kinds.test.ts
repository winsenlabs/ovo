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

it.each([
  ['response', 'confirmation'],
  ['confirmation', 'response'],
  ['response', 'disclosure'],
] as const)(
  'protects input while overlapping %s and %s await playback receipts',
  async (...kinds) => {
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
        languages: ['en-US'],
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
      mode: 'faq' as const,
      language: 'en-US',
      inputEnabled: true,
      initialInput: 'hello',
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
    );
    const scheduler = new BoundedSpeechScheduler(output);
    const order: string[] = [];
    const events: EngineEvent[] = [];
    const engine = new NativeVoiceSessionEngine({
      behavior: {
        respond: async () => '',
        async *respondStream(input) {
          order.push('input:' + input);
          if (input === 'hello') {
            yield kinds[0];
            yield kinds[1];
          }
        },
        speechKind: (text) =>
          text === 'confirmation' || text === 'disclosure' ? text : 'response',
        onPlayback: (receipt) => {
          order.push('receipt:' + receipt.text);
        },
      },
      scheduler,
      media,
      stt,
      session,
    });
    engine.subscribe((event) => events.push(event));
    try {
      await engine.start();
      await expect.poll(() => marks.length).toBe(2);
      transcribe({
        type: 'transcript',
        segment: {
          segmentId: 'answer',
          revision: 1,
          text: kinds.some((kind) => kind === 'disclosure') ? 'stop right now' : 'yes',
          stability: 'final',
        },
      });
      transcribe({ type: 'end-of-turn' });
      expect(events.filter((event) => event.type === 'interrupt')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'user.turn')).toHaveLength(0);
      for (const fn of played) fn(marks[0]!);
      await expect.poll(() => order.filter((item) => item.startsWith('receipt:')).length).toBe(1);
      expect(events.filter((event) => event.type === 'user.turn')).toHaveLength(0);
      for (const fn of played) fn(marks[1]!);
      await expect
        .poll(() => order)
        .toEqual([
          'input:hello',
          'receipt:' + kinds[0],
          'receipt:' + kinds[1],
          ...(kinds.some((kind) => kind === 'disclosure') ? [] : ['input:yes']),
        ]);
      if (kinds.some((kind) => kind === 'disclosure')) {
        transcribe({ type: 'end-of-turn' });
        expect(events.filter((event) => event.type === 'user.turn')).toHaveLength(0);
      }
    } finally {
      await engine.dispose('drain');
      output.dispose();
    }
  },
);
