import { describe, expect, it, vi } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type Inference,
  type InferenceStreamEvent,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { sttAsLegacy } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import type {
  StreamingStt,
  StreamingSttSession,
  StreamingTts,
  TranscriptRevision,
} from '@winsendotai/ovo-plugin-voice';
import {
  instrumentInference,
  instrumentSttPlugin,
  instrumentStreamingStt,
  instrumentStreamingTts,
  type StageTelemetry,
} from '../src/telemetry-stages.ts';

type StageEvent = {
  phase: 'started' | 'finished';
  stage: string;
  provider?: string;
  model?: string;
  outcome?: string;
};

describe('worker timed stages', () => {
  it('preserves the v2 STT cancel contract through the legacy engine bridge', async () => {
    const { telemetry } = stageRecorder();
    const cancel = vi.fn(async () => undefined);
    const forceEndpoint = vi.fn(async () => undefined);
    const stt: SpeechToText = {
      capabilities: {
        inputFormats: [MULAW_8K],
        languages: ['*'],
        interim: true,
        wordTimestamps: false,
        turnSignals: ['end-of-turn'],
        forceEndpoint: true,
      },
      start: async () => ({
        write: async () => undefined,
        finish: async () => undefined,
        cancel,
        forceEndpoint,
      }),
    };
    const provider = definePlugin(
      {
        id: '@fixture/stt',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'stt',
        provider: 'fixture',
        provides: [`${Cap.stt}@2`],
        requires: [],
        optional: [],
        configSchema: { type: 'object' },
        secretFields: [],
        capabilities: stt.capabilities,
        meters: [
          { key: 'fixture.stt.audio_seconds', unit: 'audio_seconds', label: 'Audio', role: 'stt' },
        ],
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['stt@1'],
      },
      (ctx) => {
        ctx.provide(Cap.stt, stt);
      },
    );
    const decorated = instrumentSttPlugin(provider, telemetry, { provider: 'fixture' });
    const composition = await compose([{ id: provider.manifest.id }], [decorated]);
    try {
      const selected = composition.ctx.get(Cap.stt) as SpeechToText;
      const session = await sttAsLegacy(selected).start({
        sessionId: 'session-1',
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        language: 'en',
        signal: new AbortController().signal,
        onTranscript: () => undefined,
      });
      await session.close('ownership_lost');
      expect(cancel).toHaveBeenCalledWith('ownership_lost');
    } finally {
      await composition.dispose();
    }
  });
  it('pairs actual inference and TTS iteration lifecycles', async () => {
    const { telemetry, events } = stageRecorder();
    const inference: Inference = {
      async generate() {
        return { kind: 'text', text: 'generated' };
      },
      async *stream(): AsyncIterable<InferenceStreamEvent> {
        yield { kind: 'text-delta', delta: 'streamed' };
        yield { kind: 'finish' };
      },
    };
    const tts: StreamingTts = {
      async *synthesize() {
        yield Uint8Array.of(1, 2, 3);
      },
    };
    instrumentInference(inference, telemetry, { provider: 'openai', model: 'gpt-test' });
    instrumentStreamingTts(tts, telemetry, { provider: 'openai', model: 'tts-test' });

    await inference.generate(inferenceRequest());
    for await (const _event of inference.stream!(inferenceRequest())) {
      // Consuming the stream is the actual provider lifecycle boundary.
    }
    for await (const _audio of tts.synthesize({
      sessionId: 'session-1',
      text: 'hello',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      signal: new AbortController().signal,
    })) {
      // Consume generated audio.
    }

    expect(events).toEqual([
      started('inference', 'openai', 'gpt-test'),
      finished('inference', 'succeeded', 'openai', 'gpt-test'),
      started('inference', 'openai', 'gpt-test'),
      finished('inference', 'succeeded', 'openai', 'gpt-test'),
      started('tts', 'openai', 'tts-test'),
      finished('tts', 'succeeded', 'openai', 'tts-test'),
    ]);
  });

  it('pairs STT readiness and one bounded processing stage per finalized utterance', async () => {
    const { telemetry, events } = stageRecorder();
    let transcript!: (revision: TranscriptRevision) => void;
    const session = sttSession();
    const stt: StreamingStt = {
      async start(input) {
        transcript = input.onTranscript;
        return session;
      },
    };
    instrumentStreamingStt(stt, telemetry, { provider: 'deepgram', model: 'nova-test' });

    const active = await stt.start({
      sessionId: 'session-1',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      language: 'en',
      signal: new AbortController().signal,
      onTranscript: () => undefined,
    });
    transcript({
      revision: 1,
      text: 'hel',
      isFinal: false,
      speechFinal: false,
      speechStarted: true,
    });
    transcript({ revision: 2, text: 'hello', isFinal: true, speechFinal: true });
    transcript({ revision: 3, text: 'next', isFinal: false, speechFinal: false });
    transcript({ revision: 4, text: 'next turn', isFinal: true, speechFinal: true });
    await active.finish();

    expect(events).toEqual([
      started('stt.ready', 'deepgram', 'nova-test'),
      finished('stt.ready', 'succeeded', 'deepgram', 'nova-test'),
      started('stt', 'deepgram', 'nova-test'),
      finished('stt', 'succeeded', 'deepgram', 'nova-test'),
      started('stt', 'deepgram', 'nova-test'),
      finished('stt', 'succeeded', 'deepgram', 'nova-test'),
    ]);
  });

  it('pairs failed provider work without telemetry becoming business authority', async () => {
    const { telemetry, events } = stageRecorder();
    const failure = new Error('provider failed');
    const inference: Inference = {
      async generate() {
        throw failure;
      },
    };
    instrumentInference(inference, telemetry, { provider: 'openai' });

    await expect(inference.generate(inferenceRequest())).rejects.toBe(failure);
    expect(events).toEqual([
      started('inference', 'openai'),
      finished('inference', 'failed', 'openai'),
    ]);
  });
});

function stageRecorder(): { telemetry: StageTelemetry; events: StageEvent[] } {
  const events: StageEvent[] = [];
  return {
    events,
    telemetry: {
      startStage(input) {
        events.push({ phase: 'started', ...input });
        let settled = false;
        return (outcome = 'succeeded') => {
          if (settled) return false;
          settled = true;
          events.push({ phase: 'finished', ...input, outcome });
          return true;
        };
      },
    },
  };
}

function sttSession(): StreamingSttSession {
  return {
    async write() {},
    async finish() {},
    async close() {},
  };
}

function inferenceRequest() {
  return {
    history: [],
    input: 'hello',
    context: '',
    uncertainty: '',
    tools: [],
    results: [],
    signal: new AbortController().signal,
  };
}

function started(stage: string, provider?: string, model?: string): StageEvent {
  return { phase: 'started', stage, provider, model };
}

function finished(stage: string, outcome: string, provider?: string, model?: string): StageEvent {
  return { phase: 'finished', stage, provider, model, outcome };
}
