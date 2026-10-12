import type { EngineEvent, VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import type { TelemetryEvent, TelemetryRepository } from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import { subscribeEngineTelemetry } from '../src/session-graph-host.ts';
import { WorkerTelemetryRuntime, type TranscriptTextPolicy } from '../src/telemetry-runtime.ts';

/** A worker telemetry session fed engine events, with what it stored (telemetry-turns tests). */
export async function harness(transcriptText?: TranscriptTextPolicy, agentId = 'agent-1') {
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
    transcriptText,
  });
  const session = await runtime.createSession({
    workspaceId: 'workspace-1',
    callId: 'call-1',
    agentId,
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
