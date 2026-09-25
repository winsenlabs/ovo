import { expect, it } from 'vitest';
import {
  MULAW_8K,
  type EngineEvent,
  type SessionInput,
  type SpeechToText,
  type SttEvent,
  type TurnDecision,
  type TurnDetectorFactory,
  type UserTurnController,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { createScriptedTts } from '../../conformance/src/drivers/scripted-speech.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';

const input: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

it('attributes VAD stop and final STT wait to the accepted speech turn', async () => {
  const carrier = createFakeCarrier();
  let emit!: (event: SttEvent) => void;
  let heard = false;
  const stt: SpeechToText = {
    capabilities: {
      inputFormats: [MULAW_8K],
      languages: ['en-US'],
      interim: true,
      wordTimestamps: false,
      turnSignals: ['end-of-turn'],
      forceEndpoint: false,
    },
    async start(options) {
      emit = options.onEvent;
      return { async write() {}, async finish() {}, async cancel() {} };
    },
  };
  const speech = new BoundedSpeechScheduler({
    async play() {
      return { state: 'completed', evidence: 'simulated' };
    },
    async interrupt() {},
  });
  const engine = new NativeVoiceSessionEngine({
    behavior: {
      respond: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'answer';
      },
      onPlayback: () => {
        heard = true;
      },
      isComplete: () => heard,
    },
    scheduler: speech,
    media: carrier.duplex,
    stt,
    vad: {
      params: { confidence: 0.5, startMs: 1, stopMs: 1, minVolume: 0, smoothing: 0 },
      create: () => ({
        frameSamples: 1,
        sampleRate: 8000,
        confidence: (pcm) => (pcm[0] === 0 ? 0 : 1),
        volume: () => 1,
        reset() {},
      }),
    },
    session: input,
  });
  const timing: Extract<EngineEvent, { type: 'timing' }>[] = [];
  engine.subscribe((event) => {
    if (event.type === 'timing') timing.push(event);
  });
  try {
    await engine.start();
    carrier.caller.audio(Uint8Array.of(0));
    carrier.caller.audio(Uint8Array.of(0xff));
    emit({
      type: 'transcript',
      segment: { segmentId: 'user-1', revision: 1, text: 'question', stability: 'final' },
    });
    emit({ type: 'end-of-turn' });
    expect((await engine.ended).reason).toBe('behavior_completed');
    const keys = timing.map((event) => event.key);
    expect(keys).toEqual(expect.arrayContaining(['vad_stop_wait', 'stt_finalize']));
    expect(timing.every((event) => event.turnId && event.ms !== undefined)).toBe(true);
    const first = timing[0]!;
    const last = timing.at(-1)!;
    expect(timing.reduce((n, event) => n + event.ms!, 0)).toBe(
      last.atMs - (first.atMs - first.ms!),
    );
  } finally {
    await engine.dispose('drain');
  }
});

it('reports streaming behavior first byte as llm_ttfb', async () => {
  const carrier = createFakeCarrier();
  let heard = false;
  const speech = new BoundedSpeechScheduler({
    async play() {
      return { state: 'completed', evidence: 'simulated' };
    },
    async interrupt() {},
  });
  const engine = new NativeVoiceSessionEngine({
    behavior: {
      respond: async () => '',
      async *respondStream() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield 'streamed answer';
      },
      onPlayback: () => {
        heard = true;
      },
      isComplete: () => heard,
    },
    scheduler: speech,
    media: carrier.duplex,
    session: { ...input, mode: 'announcement', inputEnabled: false },
  });
  const timing: Extract<EngineEvent, { type: 'timing' }>[] = [];
  engine.subscribe((event) => {
    if (event.type === 'timing') timing.push(event);
  });
  try {
    await engine.start();
    expect((await engine.ended).reason).toBe('behavior_completed');
    expect(timing.map((event) => event.key)).toContain('llm_ttfb');
  } finally {
    await engine.dispose('drain');
  }
});

it('records a bounded barge-in stage before the interrupted turn total', async () => {
  const carrier = createFakeCarrier();
  let decide!: (decision: TurnDecision) => void;
  const detector: TurnDetectorFactory = {
    create(): UserTurnController {
      const listeners = new Set<(decision: TurnDecision) => void>();
      decide = (decision) => {
        for (const listener of listeners) listener(decision);
      };
      return {
        observe() {},
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {},
      };
    },
  };
  const speech = new BoundedSpeechScheduler({
    async play() {
      return new Promise(() => undefined);
    },
    async interrupt() {},
  });
  const engine = new NativeVoiceSessionEngine({
    behavior: { respond: async () => 'long prompt' },
    scheduler: speech,
    media: carrier.duplex,
    turnDetector: detector,
    session: { ...input, mode: 'announcement', inputEnabled: false },
  });
  const timing: Extract<EngineEvent, { type: 'timing' }>[] = [];
  engine.subscribe((event) => {
    if (event.type === 'timing') timing.push(event);
  });
  try {
    await engine.start();
    await until(() => speech.history.some((event) => event.phase === 'started'));
    decide({ type: 'interrupt', reason: 'vad' });
    await until(() => timing.some((event) => event.key === 'bargein_latency'));
    const barge = timing.find((event) => event.key === 'bargein_latency')!;
    expect(barge.turnId).toBe('initial-1');
    expect(barge.ms).toBeGreaterThanOrEqual(0);
  } finally {
    await engine.dispose('drain');
  }
});

it('attributes idle and direct speech text work and delayed carrier writes', async () => {
  const carrier = createFakeCarrier({ playback: 'manual' });
  let now = 1000;
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
  let decide!: (decision: TurnDecision) => void;
  const detector: TurnDetectorFactory = {
    create() {
      const listeners = new Set<(decision: TurnDecision) => void>();
      decide = (decision) => {
        for (const listener of listeners) listener(decision);
      };
      return {
        observe() {},
        on(listener: (decision: TurnDecision) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {},
      };
    },
  };
  const media = {
    ...carrier.duplex,
    async sendAudio(bytes: Uint8Array, signal?: AbortSignal) {
      now += 23;
      await carrier.duplex.sendAudio(bytes, signal);
    },
  };
  const output = new NativeStreamingSpeechOutput(
    createScriptedTts(),
    media,
    undefined,
    () => undefined,
    { markTimeoutMs: 500 },
  );
  const speech = new BoundedSpeechScheduler(output, {}, () => now);
  const engine = new NativeVoiceSessionEngine({
    behavior: { respond: async () => '' },
    scheduler: speech,
    media,
    turnDetector: detector,
    textFilters: [
      {
        id: 'measured-filter',
        order: 1,
        apply(text) {
          now += 7;
          return text;
        },
      },
    ],
    clock,
    session: { ...input, inputEnabled: false },
  });
  const timings: Extract<EngineEvent, { type: 'timing' }>[] = [];
  engine.subscribe((event) => {
    if (event.type === 'timing') timings.push(event);
  });
  try {
    await engine.start();
    const direct = speech.speak('external speech');
    await until(() => carrier.log.filter((event) => event.type === 'mark').length === 1);
    carrier.drain();
    await direct;
    decide({ type: 'idle', retry: 1, final: false, prompt: 'idle speech' });
    await until(() => carrier.log.filter((event) => event.type === 'mark').length === 2);
    carrier.drain();
    await until(() => timings.filter((event) => event.key === 'playout_ack').length === 2);
    const text = timings.filter((event) => event.key === 'text_aggregation');
    const sent = timings.filter((event) => event.key === 'carrier_first_audio');
    expect(text).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(text.map((event) => event.turnId)).toEqual(['speech:speech-1', 'speech:speech-2']);
    expect(text.map((event) => event.ms)).toEqual([7, 7]);
    expect(sent.map((event) => event.ms)).toEqual([23, 23]);
    expect(timings.filter((event) => event.key === 'tts_ttfb')).toHaveLength(2);
  } finally {
    await engine.dispose('drain');
    output.dispose();
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timing event was not emitted');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
