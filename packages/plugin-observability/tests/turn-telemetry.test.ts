import { describe, expect, it } from 'vitest';
import type { EngineEvent, SpeechEvidence, StageKey } from '@winsendotai/ovo-contracts';
import { TurnTelemetryCollector, type TurnTelemetry } from '../src/index.ts';

const timing = (
  key: StageKey,
  turnId: string,
  atMs: number,
  ms: number,
  segmentId?: string,
): EngineEvent => ({ type: 'timing', key, turnId, atMs, ms, ...(segmentId ? { segmentId } : {}) });

const speech = (segmentId: string, phase: SpeechEvidence['phase']): EngineEvent => ({
  type: 'speech',
  evidence: {
    segmentId,
    epoch: 1,
    kind: 'response',
    text: 'unused',
    phase,
    evidence: 'confirmed',
    at: 0,
  } as SpeechEvidence,
});

function collector(includeText = true) {
  const published: TurnTelemetry[] = [];
  const turns = new TurnTelemetryCollector({ includeText, emit: (turn) => published.push(turn) });
  return {
    turns,
    published,
    latest: (turnId: string) => published.findLast((t) => t.turnId === turnId),
  };
}

/** A caller turn as the engine and the worker's provider instrumentation report it. */
function speakTurn(turns: TurnTelemetryCollector) {
  turns.engine({ type: 'user.turn', phase: 'started', turnId: 'turn-1' });
  turns.stage({ stage: 'stt.endpoint', durationMs: 640, outcome: 'succeeded' });
  turns.engine(timing('vad_stop_wait', 'turn-1', 10_300, 300));
  turns.engine(timing('stt_finalize', 'turn-1', 10_320, 20));
  turns.engine({
    type: 'user.turn',
    phase: 'stopped',
    turnId: 'turn-1',
    input: 'speech',
    text: 'What is my balance?',
  });
  turns.engine(timing('turn_decision', 'turn-1', 10_330, 10));
  turns.stage({ stage: 'grounding', durationMs: 40, outcome: 'succeeded' });
  turns.stage({
    stage: 'decision',
    durationMs: 310,
    outcome: 'succeeded',
    payload: {
      modelId: 'decision-model',
      answers: [
        { questionId: 'intent', type: 'choice', choice: 'balance', value: null, confidence: 0.91 },
      ],
    },
  });
  turns.stage({ stage: 'llm_first_token', durationMs: 450, outcome: 'succeeded' });
  turns.engine(timing('behavior_first_segment', 'turn-1', 11_500, 1_170));
  turns.engine(timing('text_aggregation', 'turn-1', 11_500, 0, 'speech-1'));
  turns.engine({
    type: 'agent.transcript',
    segmentId: 'speech-1',
    text: 'Your balance is ready.',
    state: 'generated',
  });
  turns.engine(timing('tts_ttfb', 'turn-1', 12_100, 600, 'speech-1'));
  turns.engine(timing('carrier_first_audio', 'turn-1', 12_130, 30, 'speech-1'));
  turns.engine(timing('text_aggregation', 'turn-1', 12_400, 270, 'speech-2'));
  turns.engine({
    type: 'agent.transcript',
    segmentId: 'speech-2',
    text: 'Anything else?',
    state: 'generated',
  });
  turns.stage({ stage: 'inference', durationMs: 1_400, outcome: 'succeeded' });
  turns.engine(timing('tts_ttfb', 'turn-1', 12_900, 500, 'speech-2'));
  turns.engine(timing('carrier_first_audio', 'turn-1', 13_600, 700, 'speech-2'));
  turns.engine(speech('speech-1', 'completed'));
  turns.engine(speech('speech-2', 'completed'));
}

describe('per-turn telemetry', () => {
  it('reports the flow state a decision was asked in (AGT-1)', () => {
    const { turns, latest } = collector();
    turns.engine(timing('turn_decision', 'turn-1', 1_000, 0));
    turns.stage({
      stage: 'decision',
      durationMs: 300,
      outcome: 'succeeded',
      payload: { modelId: 'jev', answers: [], flow: { node: 'greet', listen: 'identity' } },
    });
    turns.flush();
    expect(latest('turn-1')?.decision?.flow).toEqual({ node: 'greet', listen: 'identity' });
  });

  it('attributes each stage to its own interval instead of deltas between stages', () => {
    const { turns, latest } = collector();
    speakTurn(turns);
    expect(latest('turn-1')).toEqual({
      turnId: 'turn-1',
      input: 'speech',
      startedAt: new Date(10_000).toISOString(),
      endpointMs: 640,
      vadStopToFinalMs: 300,
      sttFinalizeMs: 20,
      queueMs: 10,
      groundingMs: 40,
      decision: {
        ms: 310,
        outcome: 'succeeded',
        modelId: 'decision-model',
        answers: [
          {
            questionId: 'intent',
            type: 'choice',
            choice: 'balance',
            value: null,
            confidence: 0.91,
          },
        ],
        flow: null,
      },
      llmFirstTokenMs: 450,
      llmTotalMs: 1_400,
      llmCalls: 1,
      firstSegmentMs: 1_170,
      firstAudioMs: 2_130,
      bargeInMs: null,
      interrupted: false,
      // Per-segment TTS first byte is measured from that segment's own text, not the prior stage.
      segments: [
        {
          segmentId: 'speech-1',
          ttsFirstByteMs: 600,
          carrierFirstAudioMs: 30,
          firstAudioAtMs: 2_130,
          state: 'completed',
        },
        {
          segmentId: 'speech-2',
          ttsFirstByteMs: 500,
          carrierFirstAudioMs: 700,
          firstAudioAtMs: 3_600,
          state: 'completed',
        },
      ],
      userText: 'What is my balance?',
      agentText: 'Your balance is ready. Anything else?',
      textOmitted: false,
    });
  });

  it('omits caller and agent words when the transcript switch is off', () => {
    const { turns, latest } = collector(false);
    speakTurn(turns);
    expect(latest('turn-1')).toMatchObject({
      userText: null,
      agentText: null,
      textOmitted: true,
      endpointMs: 640,
      decision: { answers: [{ choice: 'balance', confidence: 0.91 }] },
    });
    expect(JSON.stringify(latest('turn-1'))).not.toContain('balance is ready');
  });

  it("never credits an earlier utterance's end-of-turn to the next turn", () => {
    const { turns, latest } = collector();
    // A muted utterance: the controller starts and resets it, the provider still ends it.
    turns.engine({ type: 'user.turn', phase: 'started', turnId: 'turn-1' });
    turns.stage({ stage: 'stt.endpoint', durationMs: 900, outcome: 'succeeded' });
    // The next turn is stopped by the controller before the provider reports its own end-of-turn.
    turns.engine({ type: 'user.turn', phase: 'started', turnId: 'turn-2' });
    turns.engine(timing('vad_stop_wait', 'turn-2', 2_000, 300));
    turns.engine({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-2',
      input: 'speech',
      text: 'Hello?',
    });
    // Its late end-of-turn is not carried into the turn after it.
    turns.stage({ stage: 'stt.endpoint', durationMs: 450, outcome: 'succeeded' });
    turns.engine({ type: 'user.turn', phase: 'started', turnId: 'turn-3' });
    turns.engine(timing('vad_stop_wait', 'turn-3', 4_000, 300));
    turns.engine({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-3',
      input: 'speech',
      text: 'Anyone there?',
    });
    turns.flush();
    expect(latest('turn-2')?.endpointMs).toBeNull();
    expect(latest('turn-3')?.endpointMs).toBeNull();
  });

  it('never keeps DTMF digits as caller text', () => {
    const { turns, latest } = collector();
    turns.engine({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'dtmf-1',
      input: 'dtmf',
      text: '4321',
    });
    turns.flush();
    expect(latest('dtmf-1')).toMatchObject({ input: 'dtmf', userText: null });
  });

  it('gives provider stages to the running turn and publishes the previous turn when the next starts', () => {
    const { turns, published, latest } = collector();
    turns.stage({ stage: 'decision', durationMs: 5, outcome: 'succeeded' });
    expect(published).toEqual([]);
    turns.engine(timing('turn_decision', 'initial-1', 1_000, 0));
    turns.stage({ stage: 'inference', durationMs: 900, outcome: 'succeeded' });
    turns.stage({ stage: 'llm_first_token', durationMs: 300, outcome: 'unknown' });
    turns.stage({ stage: 'inference', durationMs: 100, outcome: 'succeeded', turnId: 'initial-1' });
    expect(published).toEqual([]);
    turns.engine(timing('turn_decision', 'turn-2', 5_000, 0));
    expect(latest('initial-1')).toMatchObject({
      input: 'initial',
      decision: null,
      llmFirstTokenMs: null,
      llmTotalMs: 1_000,
      llmCalls: 2,
    });
    expect(turns.activeTurnId).toBe('turn-2');
    const count = published.length;
    turns.flush();
    turns.flush();
    expect(published.length).toBe(count + 1);
  });

  it('marks barge-in on the interrupted turn', () => {
    const { turns, latest } = collector();
    turns.engine(timing('turn_decision', 'initial-1', 1_000, 0));
    turns.engine(timing('text_aggregation', 'initial-1', 1_200, 200, 'speech-1'));
    turns.engine({ type: 'interrupt', reason: 'vad' });
    turns.engine(timing('bargein_latency', 'initial-1', 1_450, 80));
    turns.engine(speech('speech-1', 'interrupted'));
    expect(latest('initial-1')).toMatchObject({
      interrupted: true,
      bargeInMs: 80,
      segments: [{ segmentId: 'speech-1', state: 'interrupted', firstAudioAtMs: null }],
    });
  });

  it('does not count a filler cut by its own reply as an interruption (P3)', () => {
    const { turns, latest } = collector();
    turns.engine(timing('turn_decision', 'turn-1', 1_000, 0));
    turns.engine(timing('text_aggregation', 'turn-1', 1_600, 600, 'speech-7'));
    turns.engine({
      type: 'speech',
      evidence: {
        segmentId: 'speech-7',
        epoch: 5,
        kind: 'acknowledgment',
        text: 'Sure, let me check that.',
        phase: 'interrupted',
        evidence: 'estimated',
        at: 0,
      } as SpeechEvidence,
    });
    expect(latest('turn-1')).toMatchObject({
      interrupted: false,
      segments: [{ segmentId: 'speech-7', state: 'interrupted' }],
    });
  });
});
