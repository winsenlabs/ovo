import { describe, expect, it } from 'vitest';
import type { TelemetryRepository } from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import { WorkerTelemetryRuntime } from '../src/telemetry-runtime.ts';
import { workerHealth } from '../src/worker-health.ts';

const repository: TelemetryRepository = {
  ingest: async (events) => ({ inserted: events.length, duplicates: 0, conflicts: 0 }),
  getCallProjection: async () => undefined,
  listCallEvents: async () => ({ events: [], nextCursor: 0, gap: null }),
  queryPerformance: async (_workspaceId, query) => ({
    from: query.from,
    to: query.to,
    bucket: query.bucket,
    groups: [],
    truncated: false,
  }),
  prune: async () => 0,
};

describe('call evidence accounting (OBS-10, OBS-12)', () => {
  it("closes each call with its telemetry.stats row and shows the writer's counters on health", async () => {
    const events: Pick<StoredCallEvent, 'type' | 'payload'>[] = [];
    const runtime = WorkerTelemetryRuntime.fromRepository(repository, {
      controlStore: {
        appendCallEvent: async (_workspaceId, _callId, type, payload) => {
          events.push({ type, payload });
          return undefined as never;
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
    session.audit('transcript.revision', { isFinal: false, text: 'he' });
    session.audit('transcript.revision', { isFinal: false, text: 'hel' });
    await session.close('caller_hangup');
    await runtime.close();
    expect(events.filter((event) => event.type === 'telemetry.stats')).toEqual([
      { type: 'telemetry.stats', payload: expect.objectContaining({ sampled: 1, dropped: 0 }) },
    ]);
    expect(events.at(-1)?.type).toBe('telemetry.stats');
    expect(workerHealth.snapshot()).toMatchObject({ callEvents: { closed: true } });
  });
});
