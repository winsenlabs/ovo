import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent, VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import type { TelemetryEvent, TelemetryRepository } from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import { subscribeEngineTelemetry } from '../src/session-graph-host.ts';
import { transcriptTextPolicyFromEnv, withoutTranscriptText } from '../src/telemetry-privacy.ts';
import { WorkerTelemetryRuntime } from '../src/telemetry-runtime.ts';

async function harness() {
  const telemetry: TelemetryEvent[] = [];
  const calls: Pick<StoredCallEvent, 'type' | 'payload'>[] = [];
  const repository = {
    ingest: async (events: readonly TelemetryEvent[]) => {
      telemetry.push(...structuredClone(events));
      return { inserted: events.length, duplicates: 0, conflicts: 0 };
    },
    getCallProjection: async () => undefined,
    listCallEvents: async () => ({ events: [], nextCursor: 0, gap: null }),
    queryPerformance: async () => ({
      from: '',
      to: '',
      bucket: 'hour',
      groups: [],
      truncated: false,
    }),
    prune: async () => 0,
  } as unknown as TelemetryRepository;
  const runtime = WorkerTelemetryRuntime.fromRepository(repository, {
    controlStore: {
      appendCallEvent: async (_workspaceId, callId, type, payload) => {
        calls.push({ type, payload: structuredClone(payload) });
        return {
          id: String(calls.length),
          callId,
          sequence: calls.length,
          at: '',
          type,
          epoch: 0,
          payload,
        };
      },
    },
  });
  const session = await runtime.createSession({
    workspaceId: 'workspace-1',
    callId: 'call-1',
    agentId: 'agent-1',
    releaseId: 'release-1',
    language: 'en-IN',
  });
  let emit!: (event: EngineEvent) => void;
  const engine = {
    subscribe(listener: (event: EngineEvent) => void) {
      emit = listener;
      return () => undefined;
    },
  } as VoiceSessionEngine;
  const unsubscribe = subscribeEngineTelemetry(engine, session);
  const finish = async () => {
    unsubscribe();
    await session.close('caller_hangup');
    await runtime.close();
  };
  return { telemetry, calls, session, emit: (event: EngineEvent) => emit(event), finish };
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
    expect(h.calls.find((event) => event.type === 'session.timing')?.payload).toEqual({
      key: 'tts_ttfb',
      turnId: 'turn-9',
      segmentId: 'speech-3',
      atMs: 240,
      ms: 40,
    });
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
