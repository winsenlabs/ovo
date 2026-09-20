import { describe, expect, it } from 'vitest';
import { AgentConfig, type SpeechReceipt } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { ScriptBehavior } from '../../behaviors/src/script.ts';
import { StreamingMediaSpeechOutput } from './media-output.ts';
import type { StreamingStt, TranscriptRevision } from './provider-types.ts';
import { BoundedSpeechScheduler } from './scheduler.ts';
import { VoiceSessionEngine } from './session-engine.ts';
import {
  createStreamingMediaSpeechOutputPlugin,
  createVoiceSessionEnginePlugin,
  STREAMING_VOICE_PLUGIN_IDS,
  STREAMING_VOICE_SERVICE_KEYS,
} from './production-plugins.ts';
import { createSpeechSchedulerPlugin } from './plugins.ts';
import { VOICE_PLUGIN_IDS } from './types.ts';
import { FakeMedia, FakeStt, tts, until } from './production-media-fixtures.ts';

describe('production media speech and session semantics', () => {
  it('records sent and confirmed playback only after the carrier mark', async () => {
    const media = new FakeMedia();
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const receipt = await scheduler.speak('hello');
    expect(receipt).toMatchObject({ state: 'completed', evidence: 'confirmed' });
    expect(scheduler.history.map((item) => item.phase)).toEqual([
      'generated',
      'queued',
      'started',
      'sent',
      'acknowledged',
      'completed',
    ]);
    await scheduler.dispose();
  });

  it('settles a cleared mark interrupted and ignores a late old mark', async () => {
    const media = new FakeMedia();
    media.autoConfirm = false;
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const pending = scheduler.speak('old response');
    await until(() => media.marks.length === 1);
    const oldMark = media.marks[0]!;
    await scheduler.interrupt();
    expect(await pending).toMatchObject({ state: 'interrupted' });
    media.emitMark(oldMark);
    expect(scheduler.history.some((item) => item.phase === 'completed')).toBe(false);
    expect(media.clears).toBeGreaterThan(0);
    await scheduler.dispose();
  });

  it('accepts one final revision, uses scheduler epochs, routes DTMF, and disposes providers', async () => {
    const media = new FakeMedia();
    const stt = new FakeStt();
    const turns: { input: string; variables?: Record<string, unknown> }[] = [];
    const epochs: number[] = [];
    const receipts: SpeechReceipt[] = [];
    const accepted: TranscriptRevision[] = [];
    let cancels = 0;
    const behavior = {
      async respond(input: string, variables?: Record<string, unknown>) {
        turns.push({ input, variables });
        return `reply ${input}`;
      },
      beginTurn(epoch: number) {
        epochs.push(epoch);
      },
      async onPlayback(receipt: SpeechReceipt) {
        receipts.push(receipt);
      },
      cancel() {
        cancels += 1;
      },
    };
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(
      behavior,
      scheduler,
      stt,
      media,
      { language: 'en-IN' },
      {
        onAcceptedTranscript(revision) {
          accepted.push(structuredClone(revision));
          throw new Error('telemetry unavailable');
        },
      },
    );
    await engine.start();
    media.emitAudio();
    stt.callback!({
      revision: 1,
      text: 'bal',
      isFinal: false,
      speechFinal: false,
      speechStarted: true,
    });
    stt.callback!({ revision: 2, text: 'balance', isFinal: true, speechFinal: true });
    stt.callback!({ revision: 2, text: 'balance', isFinal: true, speechFinal: true });
    await until(() => receipts.length === 1);
    media.emitDtmf('5');
    await until(() => receipts.length === 2);
    expect(turns).toEqual([
      { input: 'balance', variables: undefined },
      { input: '5', variables: { inputEvent: 'dtmf' } },
    ]);
    expect(epochs).toEqual([1, 2]);
    expect(accepted).toEqual([{ revision: 2, text: 'balance', isFinal: true, speechFinal: true }]);
    expect(receipts.every((receipt) => receipt.evidence === 'confirmed')).toBe(true);
    await engine.dispose('hangup');
    expect(stt.closed).toBe(true);
    expect(cancels).toBeGreaterThan(0);
  });

  it('keeps bounded STT ingress moving through pending inference and playback while superseding turns', async () => {
    const media = new FakeMedia();
    media.autoConfirm = false;
    const stt = new FakeStt();
    let resolveOld!: (text: string) => void;
    const oldResponse = new Promise<string>((resolve) => (resolveOld = resolve));
    const inputs: string[] = [];
    const receipts: SpeechReceipt[] = [];
    let cancels = 0;
    const behavior = {
      respond(input: string) {
        inputs.push(input);
        return input === 'first' ? oldResponse : Promise.resolve(`reply ${input}`);
      },
      cancel() {
        cancels++;
      },
      onPlayback(receipt: SpeechReceipt) {
        receipts.push(receipt);
      },
    };
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(behavior, scheduler, stt, media, {
      language: 'en-IN',
      maxIngressFrames: 8,
      maxIngressBytes: 64,
    });
    await engine.start();
    stt.callback!({ revision: 1, text: 'first', isFinal: true, speechFinal: true });
    await until(() => inputs.length === 1);
    media.emitAudio(Uint8Array.of(1));
    media.emitAudio(Uint8Array.of(2));
    await until(() => stt.writes === 2);

    stt.callback!({
      revision: 2,
      text: 'stop',
      isFinal: false,
      speechFinal: false,
      speechStarted: true,
    });
    stt.callback!({ revision: 3, text: 'second', isFinal: true, speechFinal: true });
    await until(() => media.marks.length === 1);
    media.emitAudio(Uint8Array.of(3));
    media.emitAudio(Uint8Array.of(4));
    await until(() => stt.writes === 4);

    stt.callback!({
      revision: 4,
      text: 'new',
      isFinal: false,
      speechFinal: false,
      speechStarted: true,
    });
    stt.callback!({ revision: 5, text: 'third', isFinal: true, speechFinal: true });
    await until(() => media.marks.length === 2);
    const [oldMark, currentMark] = media.marks;
    media.emitMark(oldMark!);
    resolveOld('late old reply');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(media.marks).toHaveLength(2);
    media.emitMark(currentMark!);
    await until(() => receipts.some((receipt) => receipt.text === 'reply third'));
    expect(inputs).toEqual(['first', 'second', 'third']);
    expect(receipts).toEqual([
      expect.objectContaining({ text: 'reply second', state: 'interrupted' }),
      expect.objectContaining({ text: 'reply third', state: 'completed' }),
    ]);
    expect(cancels).toBeGreaterThanOrEqual(2);
    expect(engine.ingressStats).toMatchObject({
      acceptedFrames: 4,
      pendingFrames: 0,
      overflows: 0,
    });
    await engine.dispose();
  });

  it('starts segmented playback before inference finishes and drops late segments on barge-in', async () => {
    const media = new FakeMedia();
    media.autoConfirm = false;
    const stt = new FakeStt();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
    const receipts: SpeechReceipt[] = [];
    const behavior = {
      respond: async () => 'unused',
      async *respondStream(input: string) {
        if (input === 'old') {
          yield 'The first sentence.';
          await oldGate;
          yield 'This stale sentence must never play.';
          return;
        }
        yield 'The fresh response.';
      },
      cancel() {
        releaseOld();
      },
      onPlayback(receipt: SpeechReceipt) {
        receipts.push(receipt);
      },
    };
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(behavior, scheduler, stt, media, { language: 'en-IN' });
    await engine.start();
    stt.callback!({ revision: 1, text: 'old', isFinal: true, speechFinal: true });
    await until(() => media.marks.length === 1);

    stt.callback!({
      revision: 2,
      text: 'stop',
      isFinal: false,
      speechFinal: false,
      speechStarted: true,
    });
    stt.callback!({ revision: 3, text: 'fresh', isFinal: true, speechFinal: true });
    await until(() => media.marks.length === 2);
    media.emitMark(media.marks[1]!);
    await until(() => receipts.some((receipt) => receipt.text === 'The fresh response.'));

    expect(receipts).toEqual([
      expect.objectContaining({ text: 'The first sentence.', state: 'interrupted' }),
      expect.objectContaining({ text: 'The fresh response.', state: 'completed' }),
    ]);
    expect(scheduler.history.some((event) => event.text.includes('stale sentence'))).toBe(false);
    await engine.dispose();
  });

  it('fails closed when the STT ingress frame or byte budget is exceeded', async () => {
    const media = new FakeMedia();
    let releaseWrite!: () => void;
    const blocked = new Promise<void>((resolve) => (releaseWrite = resolve));
    let closed = false;
    const stt: StreamingStt = {
      async start() {
        return {
          write: async () => blocked,
          finish: async () => undefined,
          close: async () => {
            closed = true;
          },
        };
      },
    };
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(
      { respond: async () => 'unused' },
      scheduler,
      stt,
      media,
      {
        language: 'en-IN',
        maxIngressFrames: 2,
        maxIngressBytes: 2,
      },
    );
    await engine.start();
    media.emitAudio(Uint8Array.of(1));
    media.emitAudio(Uint8Array.of(2));
    media.emitAudio(Uint8Array.of(3));
    await until(() => closed);
    expect(engine.ingressStats).toMatchObject({ acceptedFrames: 2, overflows: 1 });
    expect(media.closes).toContain('STT ingress capacity exceeded');
    releaseWrite();
  });

  it('starts one-way initial output without STT and closes after confirmed terminal playback', async () => {
    const media = new FakeMedia();
    const variables: Record<string, unknown>[] = [];
    let complete = false;
    const behavior = {
      async respond(_input: string, inputVariables?: Record<string, unknown>) {
        variables.push(inputVariables ?? {});
        return 'initial announcement';
      },
      onPlayback(receipt: SpeechReceipt) {
        complete = receipt.state === 'completed';
      },
      isComplete: () => complete,
    };
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(behavior, scheduler, undefined, media, {
      inputEnabled: false,
      initialInput: '',
      initialVariables: { name: 'OVO' },
    });
    await engine.start();
    await until(() => media.closes.includes('behavior_completed'));
    expect(variables).toEqual([{ name: 'OVO' }]);
    expect(media.marks).toHaveLength(1);
  });

  it('does not enqueue empty terminal speech', async () => {
    const media = new FakeMedia();
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(
      { respond: async () => '', isComplete: () => true },
      scheduler,
      undefined,
      media,
      { inputEnabled: false, initialInput: '' },
    );
    await engine.start();
    await until(() => media.closes.includes('behavior_completed'));
    expect(media.marks).toEqual([]);
  });

  it('runs an actual script from its initial prompt through a confirmed terminal mark', async () => {
    const media = new FakeMedia();
    const stt = new FakeStt();
    const behavior = new ScriptBehavior(
      AgentConfig.parse({
        name: 'Mark loopback',
        mode: 'faq',
        faq: [],
        script: {
          start: 'start',
          nodes: [
            {
              id: 'start',
              prompt: 'Press one.',
              transitions: [{ event: 'dtmf', matches: ['1'], to: 'done' }],
            },
            { id: 'done', prompt: 'Thank you.', terminal: true },
          ],
        },
      }),
    );
    const scheduler = new BoundedSpeechScheduler(new StreamingMediaSpeechOutput(tts, media));
    const engine = new VoiceSessionEngine(behavior, scheduler, stt, media, {
      language: 'en-IN',
      initialInput: '',
    });
    await engine.start();
    await until(() => media.marks.length === 1);
    media.emitDtmf('1');
    await until(() => media.closes.includes('behavior_completed'));
    expect(behavior.state).toBe('done');
    expect(media.marks).toHaveLength(2);
  });

  it('composes the session engine through ordinary scoped plugins', async () => {
    const media = new FakeMedia();
    const stt = new FakeStt();
    let responses = 0;
    const fixture = (id: string, service: string, value: unknown) =>
      definePlugin(
        {
          id,
          version: '0.1.0',
          contractVersion: 1,
          scope: 'session',
          requires: [],
          provides: [service],
          configSchema: { type: 'object', additionalProperties: false },
          secretFields: [],
        },
        (ctx) => {
          ctx.provide(service, value);
        },
      );
    const catalog = [
      fixture('fixture.behavior', STREAMING_VOICE_SERVICE_KEYS.behavior, {
        respond: async () => {
          responses += 1;
          return 'plugin reply';
        },
      }),
      fixture('fixture.stt', STREAMING_VOICE_SERVICE_KEYS.stt, stt),
      fixture('fixture.tts', STREAMING_VOICE_SERVICE_KEYS.tts, tts),
      fixture('fixture.media', STREAMING_VOICE_SERVICE_KEYS.media, media),
      createStreamingMediaSpeechOutputPlugin(),
      createSpeechSchedulerPlugin(),
      createVoiceSessionEnginePlugin(),
    ];
    const composition = await compose(
      [
        { id: 'fixture.behavior' },
        { id: 'fixture.stt' },
        { id: 'fixture.tts' },
        { id: 'fixture.media' },
        { id: STREAMING_VOICE_PLUGIN_IDS.mediaOutput },
        { id: VOICE_PLUGIN_IDS.scheduler },
        { id: STREAMING_VOICE_PLUGIN_IDS.sessionEngine, config: { language: 'en-IN' } },
      ],
      catalog,
    );
    stt.callback!({ revision: 1, text: 'hello', isFinal: true, speechFinal: true });
    await until(() => responses === 1);
    expect(composition.ctx.get(STREAMING_VOICE_SERVICE_KEYS.sessionEngine)).toBeInstanceOf(
      VoiceSessionEngine,
    );
    await composition.dispose();
  });
});
