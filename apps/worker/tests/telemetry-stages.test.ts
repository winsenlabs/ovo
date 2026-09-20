import { describe, expect, it } from 'vitest';
import type { Inference, InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import type {
  StreamingStt,
  StreamingSttSession,
  StreamingTts,
  TranscriptRevision,
} from '@winsendotai/ovo-plugin-voice';
import {
  instrumentInference,
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
