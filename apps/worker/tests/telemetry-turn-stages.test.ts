import { describe, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type DecisionPort,
  type DecisionRequest,
  type Inference,
  type InferenceStreamEvent,
  type KnowledgePort,
  type SpeechToText,
  type SttEvent,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { EndpointClock } from '../src/telemetry-stage-clocks.ts';
import { instrumentDecision, instrumentSessionPlugin } from '../src/telemetry-session-plugins.ts';
import {
  instrumentInference,
  instrumentSpeechToText,
  type StageTelemetry,
} from '../src/telemetry-stages.ts';

type Recorded = {
  phase: 'started' | 'finished' | 'recorded';
  stage: string;
  outcome?: string;
  durationMs?: number;
  payload?: Record<string, unknown>;
};

describe('per-turn provider stages', () => {
  it('measures endpointing from the audio holding the last word to end-of-turn', () => {
    let now = 0;
    const clock = new EndpointClock(MULAW_8K, () => now);
    const recorded: [number, Record<string, unknown>][] = [];
    const record = (ms: number, payload: Record<string, unknown>) => recorded.push([ms, payload]);
    // 8 kHz mu-law: 160 bytes is 20 ms of audio, written in real time.
    for (let frame = 0; frame < 50; frame++) {
      now = frame * 20;
      clock.wrote(160);
    }
    clock.observe(transcript([{ endMs: 300 }, { endMs: 610 }]), record);
    now = 1_500;
    clock.observe({ type: 'end-of-turn', eager: true }, record);
    expect(recorded).toEqual([]);
    clock.observe({ type: 'end-of-turn' }, record);
    // The frame ending at 620 ms of audio was written at 600 ms of wall clock.
    expect(recorded).toEqual([[900, { lastWordEndMs: 610, audioWrittenMs: 1_000 }]]);
    clock.observe({ type: 'end-of-turn' }, record);
    expect(recorded).toHaveLength(1);
  });

  it('records endpointing before the engine sees end-of-turn', async () => {
    const order: string[] = [];
    let emit!: (event: SttEvent) => void;
    const stt: SpeechToText = {
      capabilities: {
        inputFormats: [MULAW_8K],
        languages: ['*'],
        interim: true,
        wordTimestamps: true,
        turnSignals: ['end-of-turn'],
        forceEndpoint: false,
      },
      async start(input) {
        emit = input.onEvent;
        return { async write() {}, async finish() {}, async cancel() {} };
      },
    };
    const { telemetry, events } = recorder();
    telemetry.recordStage = (input) => {
      order.push('recorded');
      events.push({ phase: 'recorded', ...input });
      return true;
    };
    instrumentSpeechToText(stt, telemetry, { provider: 'fixture' });
    const session = await stt.start({
      sessionId: 'session-1',
      format: MULAW_8K,
      language: 'en',
      signal: new AbortController().signal,
      onEvent: (event) => order.push(event.type),
      onUsage: () => undefined,
    });
    await session.write(new Uint8Array(1_600));
    emit(transcript([{ endMs: 50 }]));
    emit({ type: 'end-of-turn' });
    expect(order).toEqual(['transcript', 'recorded', 'end-of-turn']);
    expect(events.find((event) => event.phase === 'recorded')).toMatchObject({
      stage: 'stt.endpoint',
      payload: { lastWordEndMs: 50, audioWrittenMs: 200 },
    });
  });

  it('times the first streamed token separately from the whole inference stream', async () => {
    const { telemetry, events } = recorder();
    let release!: () => void;
    const rest = new Promise<void>((resolve) => (release = resolve));
    const inference: Inference = {
      async generate() {
        return { kind: 'text', text: 'unused' };
      },
      async *stream(): AsyncIterable<InferenceStreamEvent> {
        yield { kind: 'text-delta', delta: ' ' };
        yield { kind: 'text-delta', delta: 'Hello' };
        await rest;
        yield { kind: 'text-delta', delta: ' there' };
        yield { kind: 'finish' };
      },
    };
    instrumentInference(inference, telemetry, { provider: 'fixture' });
    const iterator = inference.stream!({} as never)[Symbol.asyncIterator]();
    await iterator.next();
    expect(events.map((event) => `${event.phase}:${event.stage}`)).toEqual([
      'started:inference',
      'started:llm_first_token',
    ]);
    await iterator.next();
    expect(events.at(-1)).toMatchObject({ phase: 'finished', stage: 'llm_first_token' });
    release();
    while (!(await iterator.next()).done);
    expect(events.at(-1)).toMatchObject({ phase: 'finished', stage: 'inference' });
  });

  it('records the decision choice and confidence without the question state', async () => {
    const { telemetry, events } = recorder();
    const port: DecisionPort = {
      async decide() {
        return {
          modelId: 'decision-model',
          answers: {
            intent: {
              type: 'choice',
              choice: 'balance',
              confidence: 0.92,
              calibrationVersion: 'cohort-1',
              probabilities: { balance: 0.92, other: 0.08 },
            },
            consent: {
              type: 'noul',
              noul: 0.2,
              confidence: 0.8,
              calibrationVersion: 'cohort-1',
              probabilities: { yes: 0.2, no: 0.8 },
            },
          },
        };
      },
    };
    instrumentDecision(port, telemetry, { provider: 'fixture' });
    const request = { state: { lastCallerTurn: 'my card number is 4111' }, questions: {} };
    const response = await port.decide(request as unknown as DecisionRequest, {
      signal: new AbortController().signal,
    });
    expect(response.modelId).toBe('decision-model');
    const finished = events.find((event) => event.phase === 'finished')!;
    expect(finished).toMatchObject({
      stage: 'decision',
      outcome: 'succeeded',
      payload: {
        modelId: 'decision-model',
        answers: [
          {
            questionId: 'intent',
            type: 'choice',
            choice: 'balance',
            value: null,
            confidence: 0.92,
          },
          { questionId: 'consent', type: 'noul', choice: null, value: 0.2, confidence: 0.8 },
        ],
      },
    });
    expect(JSON.stringify(finished)).not.toContain('4111');
  });

  it('stamps the flow state a decision was asked in, ids only', async () => {
    const { telemetry, events } = recorder();
    const port: DecisionPort = {
      async decide() {
        return { modelId: 'jev', answers: {} } as never;
      },
    };
    instrumentDecision(port, telemetry, { provider: 'fixture' });
    await port.decide({ state: 'x', questions: {} } as never, {
      signal: new AbortController().signal,
      trace: { flow: { node: 'greet', listen: 'identity' } },
    });
    expect(events.find((event) => event.phase === 'finished')).toMatchObject({
      payload: { flow: { node: 'greet', listen: 'identity' } },
    });
  });

  it('reports a decision deadline as a timeout and rethrows it', async () => {
    const { telemetry, events } = recorder();
    const timeout = new DOMException('deadline', 'TimeoutError');
    const port: DecisionPort = {
      async decide() {
        throw timeout;
      },
    };
    instrumentDecision(port, telemetry, {});
    await expect(
      port.decide({} as DecisionRequest, { signal: new AbortController().signal }),
    ).rejects.toBe(timeout);
    expect(events.at(-1)).toMatchObject({ stage: 'decision', outcome: 'timeout' });
  });

  it('decorates selected decision and knowledge plugins in the session graph', async () => {
    const { telemetry, events } = recorder();
    const knowledge: KnowledgePort = {
      async search() {
        return { passages: [], revision: 'r1' };
      },
    };
    const decision: DecisionPort = {
      async decide() {
        return { modelId: 'm', answers: {} };
      },
    };
    const definitions = [
      sessionPlugin(DECISION_MANIFEST, Cap.decision, decision),
      sessionPlugin(KNOWLEDGE_MANIFEST, Cap.knowledge, knowledge),
    ];
    const composition = await compose(
      definitions.map((definition) => ({ id: definition.manifest.id })),
      definitions.map((definition) => instrumentSessionPlugin(definition, telemetry)),
    );
    try {
      const signal = new AbortController().signal;
      await (composition.ctx.get(Cap.decision) as DecisionPort).decide({} as DecisionRequest, {
        signal,
      });
      await (composition.ctx.get(Cap.knowledge) as KnowledgePort).search(
        { text: 'hours', topK: 1, sourceIds: [] },
        { signal },
      );
      expect(events.map((event) => `${event.phase}:${event.stage}`)).toEqual([
        'started:decision',
        'finished:decision',
        'started:grounding',
        'finished:grounding',
      ]);
    } finally {
      await composition.dispose();
    }
  });
});

const DECISION_MANIFEST = {
  kind: 'decision',
  capabilities: {
    primitives: ['choice', 'noul', 'score'],
    maxCriteria: 255,
    maxQuestionsPerRequest: 8,
    languages: ['en'],
    calibration: { label: 'fixture', source: 'fixture' },
  },
  meters: [{ key: 'fixture.decision', unit: 'input_tokens', label: 'Tokens', role: 'decision' }],
} as const;
const KNOWLEDGE_MANIFEST = {
  kind: 'knowledge',
  capabilities: {
    scoreBasis: 'lexical',
    maxTopK: 50,
    maxPassageCharacters: 2_000,
    languages: ['*'],
    citations: false,
    mutableCorpus: false,
  },
} as const;

function sessionPlugin(
  shape: typeof DECISION_MANIFEST | typeof KNOWLEDGE_MANIFEST,
  key: string,
  service: unknown,
) {
  return definePlugin(
    {
      ...shape,
      id: `@fixture/${shape.kind}`,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      provider: 'fixture',
      provides: [key],
      requires: [],
      optional: [],
      configSchema: { type: 'object' },
      secretFields: [],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: [`${shape.kind}@1`],
    },
    (ctx) => {
      ctx.provide(key, service);
    },
  );
}

function transcript(words: { endMs: number }[]): SttEvent {
  return {
    type: 'transcript',
    segment: {
      segmentId: '0',
      revision: 1,
      text: 'hello',
      stability: 'final',
      words: words.map((word) => ({ text: 'w', startMs: word.endMs - 10, ...word, final: true })),
    },
  };
}

function recorder(): { telemetry: StageTelemetry; events: Recorded[] } {
  const events: Recorded[] = [];
  return {
    events,
    telemetry: {
      startStage(input) {
        events.push({ phase: 'started', ...input });
        return (outcome = 'succeeded', payload) => {
          events.push({ phase: 'finished', ...input, outcome, ...(payload ? { payload } : {}) });
          return true;
        };
      },
    },
  };
}
