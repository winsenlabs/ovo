import { describe, expect, it } from 'vitest';
import type { Inference, InferenceRequest, InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import { ActivityListeners, type InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import type {
  TurnTelemetryCollector,
  WorkerTelemetryAdapter,
} from '@winsendotai/ovo-plugin-observability';
import { instrumentInference, type StageTelemetry } from '../src/telemetry-stages.ts';
import { startTurnStage } from '../src/telemetry-turn-stage.ts';

type Recorded = {
  phase: 'started' | 'finished';
  stage: string;
  outcome?: string;
  payload?: Record<string, unknown>;
};

function recorder(): { telemetry: StageTelemetry; events: Recorded[] } {
  const events: Recorded[] = [];
  return {
    events,
    telemetry: {
      startStage(input) {
        events.push({ phase: 'started', stage: input.stage });
        return (outcome = 'succeeded', payload) => {
          events.push({
            phase: 'finished',
            stage: input.stage,
            outcome,
            ...(payload ? { payload } : {}),
          });
          return true;
        };
      },
    },
  };
}

/** An inference port that reports provider tools as AiSdkInference does. */
function searchingInference() {
  const activity = new ActivityListeners();
  const inference: Inference & ActivityListeners = Object.assign(activity, {
    generate: async () => ({ kind: 'text' as const, text: '' }),
    async *stream(): AsyncIterable<InferenceStreamEvent> {
      yield { kind: 'finish' };
    },
  });
  const signal = new AbortController().signal;
  const started = (id: string, tool = 'web_search'): InferenceActivity => ({
    phase: 'started',
    tool,
    id,
    atMs: 0,
    signal,
  });
  const finished = (
    id: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    extra: { action?: string; results?: number } = {},
  ): InferenceActivity => ({
    phase: 'finished',
    tool: 'web_search',
    id,
    atMs: 0,
    signal,
    outcome,
    durationMs: 0,
    ...extra,
  });
  return { inference, emit: (event: InferenceActivity) => activity.emit(event), started, finished };
}

describe('the web_search stage (N3)', () => {
  it('times each search from its start to its result, with the sources it returned', () => {
    const { telemetry, events } = recorder();
    const { inference, emit, started, finished } = searchingInference();
    instrumentInference(inference, telemetry, { provider: 'openai' });
    emit(started('ws-1'));
    expect(events).toEqual([{ phase: 'started', stage: 'web_search' }]);
    emit(started('other-1', 'code_interpreter'));
    emit(finished('ws-1', 'succeeded', { action: 'search', results: 5 }));
    emit(started('ws-2'));
    emit(finished('ws-2', 'cancelled'));
    expect(events).toEqual([
      { phase: 'started', stage: 'web_search' },
      {
        phase: 'finished',
        stage: 'web_search',
        outcome: 'succeeded',
        payload: { action: 'search', results: 5 },
      },
      { phase: 'started', stage: 'web_search' },
      {
        phase: 'finished',
        stage: 'web_search',
        outcome: 'unknown',
        payload: { action: null, results: null },
      },
    ]);
  });

  it('counts a call asked ahead, and its search, on the turn it was asked for (Wave 10, B2)', async () => {
    // Call 4f1a919d: turn 7 showed searchCalls 2; one was the call asked for turn 8's "Madras."
    // while turn 7 was being answered. Behaviours mark such a request, and its signal, with the
    // utterance (behaviors speculation-llm.ts, SPECULATED_UTTERANCE).
    const asked = Symbol.for('ovo.speculation.utterance');
    const stages: { stage: string; turnId?: string }[] = [];
    const adapter = { startStage: () => () => true } as unknown as WorkerTelemetryAdapter;
    const turns = {
      activeTurnId: 'turn-7',
      stage: (sample: { stage: string; turnId?: string }) => stages.push(sample),
    } as unknown as TurnTelemetryCollector;
    const telemetry: StageTelemetry = {
      startStage: (input) => startTurnStage(adapter, turns, input, () => undefined),
    };
    const { inference, emit } = searchingInference();
    instrumentInference(inference, telemetry, { provider: 'openai' });
    const signal = new AbortController().signal;
    Object.defineProperty(signal, asked, { value: 'turn-8' });
    const request = Object.defineProperty({ signal } as never as InferenceRequest, asked, {
      value: 'turn-8',
    });
    for await (const _ of inference.stream!(request));
    for (const phase of ['started', 'finished'] as const)
      emit({
        phase,
        tool: 'web_search',
        id: 'ws-8',
        atMs: 0,
        signal,
        ...(phase === 'finished' ? { outcome: 'succeeded' as const, durationMs: 0 } : {}),
      } as InferenceActivity);
    // The turn's own call is stamped with the running turn, as before.
    for await (const _ of inference.stream!({ signal: new AbortController().signal } as never));
    expect(stages.map(({ stage, turnId }) => [stage, turnId])).toEqual([
      ['llm_first_token', 'turn-8'],
      ['inference', 'turn-8'],
      ['web_search', 'turn-8'],
      ['llm_first_token', 'turn-7'],
      ['inference', 'turn-7'],
    ]);
  });

  it('counts a call asked ahead on its turn when only its signal is marked (Wave 10, B2)', async () => {
    // behaviors SearchBudget.limit copies a request over its search budget ({ ...request,
    // providerTools: false }), which drops the request's own non-enumerable mark.
    const asked = Symbol.for('ovo.speculation.utterance');
    const stages: { stage: string; turnId?: string }[] = [];
    const adapter = { startStage: () => () => true } as unknown as WorkerTelemetryAdapter;
    const turns = {
      activeTurnId: 'turn-7',
      stage: (sample: { stage: string; turnId?: string }) => stages.push(sample),
    } as unknown as TurnTelemetryCollector;
    const telemetry: StageTelemetry = {
      startStage: (input) => startTurnStage(adapter, turns, input, () => undefined),
    };
    const { inference } = searchingInference();
    instrumentInference(inference, telemetry, { provider: 'openai' });
    const signal = new AbortController().signal;
    Object.defineProperty(signal, asked, { value: 'turn-8' });
    const request = Object.defineProperty({ signal } as never as InferenceRequest, asked, {
      value: 'turn-8',
    });
    for await (const _ of inference.stream!({ ...request, providerTools: false }));
    await inference.generate({ ...request, providerTools: false });
    expect(stages.map(({ stage, turnId }) => [stage, turnId])).toEqual([
      ['llm_first_token', 'turn-8'],
      ['inference', 'turn-8'],
      ['inference', 'turn-8'],
    ]);
  });

  it('is stamped with the running turn, as the other reply stages are', () => {
    const stages: { stage: string; turnId?: string }[] = [];
    const adapter = { startStage: () => () => true } as unknown as WorkerTelemetryAdapter;
    const turns = {
      activeTurnId: 'turn-7',
      stage: (sample: { stage: string; turnId?: string }) => stages.push(sample),
    } as unknown as TurnTelemetryCollector;
    startTurnStage(adapter, turns, { stage: 'web_search' }, () => undefined)('succeeded');
    expect(stages).toMatchObject([{ stage: 'web_search', turnId: 'turn-7' }]);
  });
});
