import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent, VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import { subscribeEngineTelemetry } from '../src/session-graph-host.ts';
import { transcriptTextPolicyFromEnv, withoutTranscriptText } from '../src/telemetry-privacy.ts';
import { harness } from './telemetry-turns-harness.ts';

/** One caller turn as the engine reports it, with the provider stages the worker times. */
function callerTurn(h: Awaited<ReturnType<typeof harness>>) {
  h.emit({ type: 'user.turn', phase: 'started', turnId: 'turn-1' });
  h.session.recordStage({ stage: 'stt.endpoint', durationMs: 700 });
  h.emit({ type: 'timing', key: 'stt_finalize', turnId: 'turn-1', atMs: 5_020, ms: 20 });
  h.emit({
    type: 'user.turn',
    phase: 'stopped',
    turnId: 'turn-1',
    input: 'speech',
    text: 'My PIN is 4321',
  });
  h.emit({
    type: 'user.transcript',
    turnId: 'stt-1',
    segmentId: 'stt-1',
    text: 'My PIN is 4321',
    stability: 'final',
  });
  h.emit({ type: 'timing', key: 'turn_decision', turnId: 'turn-1', atMs: 5_030, ms: 10 });
  h.session.startStage({ stage: 'decision', provider: 'fixture' })('succeeded', {
    modelId: 'decision-model',
    answers: [
      { questionId: 'intent', type: 'choice', choice: 'pin', value: null, confidence: 0.7 },
    ],
  });
  h.session.startStage({ stage: 'llm_first_token' })('succeeded');
  h.session.startStage({ stage: 'inference' })('succeeded');
  h.emit({
    type: 'timing',
    key: 'text_aggregation',
    turnId: 'turn-1',
    segmentId: 'speech-1',
    atMs: 5_900,
    ms: 0,
  });
  h.emit({
    type: 'agent.transcript',
    segmentId: 'speech-1',
    text: 'Thanks, verifying.',
    state: 'generated',
  });
  h.emit({
    type: 'timing',
    key: 'tts_ttfb',
    turnId: 'turn-1',
    segmentId: 'speech-1',
    atMs: 6_400,
    ms: 500,
  });
  h.emit({
    type: 'timing',
    key: 'carrier_first_audio',
    turnId: 'turn-1',
    segmentId: 'speech-1',
    atMs: 6_420,
    ms: 20,
  });
}

describe('live per-turn telemetry', () => {
  it('records engine timings with their turn and segment in telemetry and call events', async () => {
    const h = await harness();
    h.emit({
      type: 'timing',
      key: 'tts_ttfb',
      turnId: 'turn-9',
      segmentId: 'speech-3',
      atMs: 240,
      ms: 40,
    });
    await h.finish();
    expect(h.telemetry.find((event) => event.stage === 'tts_ttfb')).toMatchObject({
      kind: 'stage.completed',
      turnId: 'turn-9',
      segmentId: 'speech-3',
      durationMs: 40,
    });
    // OBS-10: the timing is written once, inside its engine.event row, not again as session.timing.
    expect(h.calls.filter((event) => event.type === 'session.timing')).toEqual([]);
    expect(
      h.calls.find(
        (event) =>
          event.type === 'engine.event' &&
          (event.payload.event as { type?: string } | undefined)?.type === 'timing',
      )?.payload.event,
    ).toEqual({
      type: 'timing',
      key: 'tts_ttfb',
      turnId: 'turn-9',
      segmentId: 'speech-3',
      atMs: 240,
      ms: 40,
    });
  });

  it('publishes a turn summary and stamps provider stages with the running turn', async () => {
    const h = await harness();
    callerTurn(h);
    await h.finish();
    const decision = h.telemetry.find(
      (event) => event.stage === 'decision' && event.kind === 'stage.completed',
    );
    expect(decision).toMatchObject({ turnId: 'turn-1', payload: { modelId: 'decision-model' } });
    expect(h.calls.find((event) => event.type === 'decision.made')?.payload).toMatchObject({
      turnId: 'turn-1',
      outcome: 'succeeded',
      answers: [{ questionId: 'intent', choice: 'pin', confidence: 0.7 }],
    });
    const summaries = h.telemetry.filter((event) => event.kind === 'turn.summary');
    expect(summaries.at(-1)).toMatchObject({
      turnId: 'turn-1',
      payload: {
        summary: {
          endpointMs: 700,
          sttFinalizeMs: 20,
          queueMs: 10,
          llmCalls: 1,
          firstAudioMs: 1_420,
          decision: { modelId: 'decision-model' },
          segments: [{ segmentId: 'speech-1', ttsFirstByteMs: 500, carrierFirstAudioMs: 20 }],
          userText: 'My PIN is 4321',
          agentText: 'Thanks, verifying.',
          textOmitted: false,
        },
      },
    });
  });

  it('records the reply.waits stage, whose parts add up to firstAudioMs (Wave 8 fix 3)', async () => {
    const h = await harness();
    callerTurn(h);
    await h.finish();
    const waits = h.telemetry.find((event) => event.stage === 'reply.waits');
    expect(waits).toMatchObject({ turnId: 'turn-1', durationMs: 1_420 });
    expect(waits?.payload).toMatchObject({ endpointMs: 20, queueMs: 10, composeMs: 870 });
    expect(waits?.payload).toMatchObject({ ttsFirstByteMs: 500, carrierMs: 20 });
  });

  // Live calls 2026-10-07 (Scribe, no word timings): endpointMs was null on every turn summary.
  it("takes the engine's endpoint when the provider has no word timings to measure one", async () => {
    const h = await harness();
    h.emit({ type: 'user.turn', phase: 'started', turnId: 'turn-1' });
    h.emit({ type: 'timing', key: 'vad_stop_wait', turnId: 'turn-1', atMs: 2_000, ms: 443 });
    h.emit({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-1',
      input: 'speech',
      text: 'Yes, sir.',
      endpointMs: 648,
    });
    h.emit({ type: 'timing', key: 'turn_decision', turnId: 'turn-1', atMs: 2_010, ms: 10 });
    // A provider measure, from its word timings, is the better one when there is one.
    h.emit({ type: 'user.turn', phase: 'started', turnId: 'turn-2' });
    h.session.recordStage({ stage: 'stt.endpoint', durationMs: 610 });
    h.emit({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-2',
      input: 'speech',
      text: 'Tomorrow.',
      endpointMs: 700,
    });
    h.emit({ type: 'timing', key: 'turn_decision', turnId: 'turn-2', atMs: 4_010, ms: 10 });
    // Keypad digits have no endpoint.
    h.emit({ type: 'user.turn', phase: 'started', turnId: 'turn-3' });
    h.emit({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-3',
      input: 'dtmf',
      text: '1',
      endpointMs: 5,
    });
    h.emit({ type: 'timing', key: 'turn_decision', turnId: 'turn-3', atMs: 6_010, ms: 10 });
    await h.finish();
    const summary = (turnId: string) =>
      h.telemetry.filter((event) => event.kind === 'turn.summary' && event.turnId === turnId).at(-1)
        ?.payload as { summary: { endpointMs: number | null; vadStopToFinalMs?: number | null } };
    expect(summary('turn-1').summary).toMatchObject({ endpointMs: 648, vadStopToFinalMs: 443 });
    expect(summary('turn-2').summary.endpointMs).toBe(610);
    expect(summary('turn-3').summary.endpointMs).toBeNull();
  });

  // Wave 9 D2: the engine now publishes a dropped turn (`user.turn` reset, call 10d5ef30's
  // "Tell me the name."). It is not the running turn's start or stop, so it must not discard the
  // provider's endpoint measure for that turn.
  it("keeps the provider's endpoint when a dropped turn's reset arrives mid-turn", async () => {
    const h = await harness();
    h.emit({ type: 'user.turn', phase: 'started', turnId: 'turn-1' });
    h.session.recordStage({ stage: 'stt.endpoint', durationMs: 610 });
    h.emit({
      type: 'user.turn',
      phase: 'reset',
      turnId: 'turn-0',
      resetReason: 'backchannel',
      text: 'Tell me the name.',
    });
    h.emit({
      type: 'user.turn',
      phase: 'stopped',
      turnId: 'turn-1',
      input: 'speech',
      text: 'Tomorrow.',
      endpointMs: 700,
    });
    h.emit({ type: 'timing', key: 'turn_decision', turnId: 'turn-1', atMs: 4_010, ms: 10 });
    await h.finish();
    const summary = h.telemetry
      .filter((event) => event.kind === 'turn.summary' && event.turnId === 'turn-1')
      .at(-1)?.payload as { summary: { endpointMs: number | null } };
    expect(summary.summary.endpointMs).toBe(610);
  });

  it('keeps no caller or agent words anywhere when the transcript switch omits them', async () => {
    const h = await harness(
      { default: 'store', agents: { 'agent-private': 'omit' } },
      'agent-private',
    );
    callerTurn(h);
    h.session.transcript(
      { revision: 1, text: 'My PIN is 4321', isFinal: true, speechFinal: true },
      true,
    );
    await h.finish();
    // Random event ids can contain the digits; only the words matter here.
    const stored = JSON.stringify([h.calls, h.telemetry]).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      '<id>',
    );
    expect(stored).not.toContain('4321');
    expect(stored).not.toContain('verifying');
    expect(h.telemetry.filter((event) => event.kind === 'turn.summary').at(-1)).toMatchObject({
      payload: { summary: { userText: null, agentText: null, textOmitted: true, endpointMs: 700 } },
    });
    const accepted = h.calls.filter((event) => event.type === 'transcript.accepted');
    expect(accepted.length).toBeGreaterThan(0);
    for (const event of accepted)
      expect(event.payload).toMatchObject({ text: null, textOmitted: true });
  });
});

describe('engine telemetry isolation', () => {
  it('never lets a failing recorder throw into the engine that is running the turn', () => {
    let emit!: (event: EngineEvent) => void;
    const engine = {
      subscribe(listener: (event: EngineEvent) => void) {
        emit = listener;
        return () => undefined;
      },
    } as VoiceSessionEngine;
    const failing = {
      adapter: {
        timing: () => {
          throw new Error('telemetry store unavailable');
        },
        speech: () => {
          throw new Error('telemetry store unavailable');
        },
      },
      audit: () => true,
    };
    const heard: string[] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    subscribeEngineTelemetry(engine, failing as never, (event) =>
      heard.push(event.evidence.segmentId),
    );
    expect(() =>
      emit({ type: 'timing', key: 'tts_ttfb', turnId: 'turn-1', atMs: 1, ms: 1 }),
    ).not.toThrow();
    emit({
      type: 'speech',
      evidence: {
        segmentId: 'speech-1',
        epoch: 1,
        kind: 'response',
        text: 'hi',
        phase: 'completed',
        evidence: 'confirmed',
        at: 1,
      } as never,
    });
    expect(heard).toEqual(['speech-1']);
    // The failure is reported, once per call, rather than dropped.
    expect(logged.mock.calls).toEqual([['worker telemetry error:', 'telemetry store unavailable']]);
    logged.mockRestore();
  });
});

describe('transcript text policy', () => {
  it('reads the installation default and per-agent overrides', () => {
    expect(transcriptTextPolicyFromEnv({})).toEqual({ default: 'store', agents: {} });
    expect(
      transcriptTextPolicyFromEnv({
        OVO_TELEMETRY_TRANSCRIPT_TEXT: 'omit',
        OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS: 'agent-a=store, agent-b=omit',
      }),
    ).toEqual({ default: 'omit', agents: { 'agent-a': 'store', 'agent-b': 'omit' } });
    expect(() => transcriptTextPolicyFromEnv({ OVO_TELEMETRY_TRANSCRIPT_TEXT: 'redact' })).toThrow(
      'OVO_TELEMETRY_TRANSCRIPT_TEXT must be store or omit',
    );
    expect(() =>
      transcriptTextPolicyFromEnv({ OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS: 'agent-a' }),
    ).toThrow('must be store or omit');
  });

  it('blanks words inside copied engine events and leaves other evidence alone', () => {
    expect(
      withoutTranscriptText({
        atMs: 5,
        event: {
          type: 'agent.transcript',
          segmentId: 's',
          text: 'secret',
          spokenPrefix: 'sec',
          state: 'interrupted',
        },
      }),
    ).toEqual({
      atMs: 5,
      event: { type: 'agent.transcript', segmentId: 's', text: '', state: 'interrupted' },
      textOmitted: true,
    });
    expect(withoutTranscriptText({ key: 'tts_ttfb', ms: 4 })).toEqual({ key: 'tts_ttfb', ms: 4 });
  });
});
