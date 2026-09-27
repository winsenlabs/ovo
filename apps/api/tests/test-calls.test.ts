import { mockFixtureAdmission } from './fixture-admission-support.ts';
import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Cap, MULAW_8K } from '@winsendotai/ovo-contracts';
import {
  LocalRecordingBackend,
  RecordingArchive,
  inspectWav,
} from '@winsendotai/ovo-plugin-recordings';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { registerInspectionRoutes } from '../src/routes/inspection.ts';
import { registerTestCallRoutes } from '../src/routes/test-calls.ts';
import { TestCallRuntime, fixtureCallsEnabled } from '../src/test-call-runtime.ts';
import { createFixtureRecordingPort, persistFixtureRecording } from '../src/recording-runtime.ts';
import { createRecordingExportInputLoader } from '../src/routes/recording-lifecycle-data.ts';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { TelemetryEvent } from '@winsendotai/ovo-plugin-observability';

const callId = '20a1422f-2905-420d-b97b-215918dc07f9';
const releaseId = 'a24a2c3d-58e7-40e4-86f0-d931c040df7e';
const agentId = '31439c24-9d99-4a49-8dba-c46f9077198c';
const createdAt = '2026-09-25T12:00:00.000Z';

describe('fixture test-call inspection', () => {
  it('returns 404 when disabled and durably streams a release-backed call when enabled', async () => {
    const directory = await mkdtemp('/var/tmp/ovo-disabled-fixture-recording-');
    const archive = new RecordingArchive(new LocalRecordingBackend(join(directory, 'objects')));
    const release = {
      id: releaseId,
      agentId,
      workspaceId: 'workspace',
      config: {
        recording: false,
        costPolicy: {
          priceCards: {
            'fixture.streaming-tts.characters': { id: 'card-1', version: 'v1' },
          },
        },
      },
      selections: {},
      providerBindings: {},
      plugins: [],
    };
    let latestRelease = release;
    const callRows = new Map<
      string,
      { id: string; kind: 'test'; releaseId: string; status: string }
    >();
    const usageRows: Record<string, unknown>[] = [];
    const telemetryEvents: TelemetryEvent[] = [];
    const eventRows = new Map<
      string,
      {
        id: string;
        callId: string;
        sequence: number;
        at: string;
        type: string;
        epoch: number;
        payload: Record<string, unknown>;
      }[]
    >();
    const store = {
      getAgent: vi.fn(async () => ({ id: agentId, workspaceId: 'workspace' })),
      getRelease: vi.fn(async () => release),
      listReleases: vi.fn(async () => ({ items: [latestRelease], nextCursor: null })),
      getCall: vi.fn(async (_workspace: string, id: string) => callRows.get(id)),
      createCall: vi.fn(async (row: { id: string; releaseId: string; status: string }) => {
        const saved = { ...row, kind: 'test' as const };
        callRows.set(row.id, saved);
        return saved;
      }),
      finishCall: vi.fn(async (_workspace: string, id: string, status: string) => {
        const saved = callRows.get(id)!;
        saved.status = status;
        return saved;
      }),
      appendCallEvent: vi.fn(
        async (_workspace: string, id: string, type: string, payload: Record<string, unknown>) => {
          const rows = eventRows.get(id) ?? [];
          const row = {
            id: `event-${rows.length + 1}`,
            callId: id,
            sequence: rows.length + 1,
            at: createdAt,
            type,
            epoch: 0,
            payload,
          };
          rows.push(row);
          eventRows.set(id, rows);
          return row;
        },
      ),
      listCallEvents: vi.fn(async (_workspace: string, id: string) => ({
        items: eventRows.get(id) ?? [],
        nextCursor: null,
      })),
      addUsage: vi.fn(async (row: Record<string, unknown>) => {
        usageRows.push(row);
        return row;
      }),
      listUsage: vi.fn(async () => ({ items: usageRows, nextCursor: null })),
      listCalls: vi.fn(async () => ({ items: [...callRows.values()], nextCursor: null })),
    } as unknown as ControlStore;
    const buildRoute = (enabled: boolean) => {
      const app = Fastify();
      const runtime = new TestCallRuntime({
        enabled,
        execute: async (job, onEvent) => {
          await onEvent({
            seq: 1,
            atMs: 100,
            event: {
              type: 'user.transcript',
              turnId: 'turn-1',
              segmentId: 'segment-1',
              text: 'Hello',
              stability: 'final',
            },
          });
          return {
            callId: job.callId,
            kind: 'test',
            status: 'completed',
            outcome: { reason: 'behavior_completed', outcome: 'completed' },
            events: [],
            selections: {},
            sttMode: 'template',
            usage: [
              {
                provider: 'fixture',
                operation: 'tts',
                unit: 'characters',
                quantity: '10',
                state: 'estimated',
                requestId: 'fixture-request',
                elapsedMs: 1,
              },
            ],
            carrierFrames: [],
            compatIssues: [],
            recording: {
              format: MULAW_8K,
              tracks: {
                caller: [{ atMs: 0, bytesBase64: '/w==' }],
                agent: [{ atMs: 0, bytesBase64: '/w==' }],
              },
            },
          };
        },
      });
      registerTestCallRoutes({
        app,
        store: mockFixtureAdmission(store),
        requireRole: () => ({ workspaceId: 'workspace' }) as never,
        testCallRuntime: runtime,
        telemetry: {
          tryEnqueue: (event: TelemetryEvent) => {
            telemetryEvents.push(event);
            return true;
          },
        } as never,
        ctx: {
          get: (key: string) =>
            key === Cap.recordings
              ? archive
              : {
                  getPriceCard: async () => ({
                    id: 'card-1',
                    version: 'v1',
                    provider: 'fixture',
                    unit: 'characters',
                    currency: 'INR',
                    minorUnitsPerBlock: '2',
                    blockQuantity: '1',
                  }),
                },
        } as never,
      });
      registerInspectionRoutes({
        app,
        store,
        z,
        Id: z.uuid(),
        requireRole: () => ({ workspaceId: 'workspace' }),
        queryPage: () => ({ limit: 50 }),
        error: (
          response: { code(n: number): { send(v: unknown): unknown } },
          status: number,
          code: string,
        ) => response.code(status).send({ code }),
      });
      return app;
    };
    const disabled = buildRoute(false);
    const disabledResponse = await disabled.inject({
      method: 'POST',
      url: `/v1/agents/${agentId}/test-calls`,
      payload: { releaseId },
    });
    expect(disabledResponse.statusCode).toBe(404);
    expect(disabledResponse.json().code).toBe('fixture_calls_disabled');
    await disabled.close();
    const enabled = buildRoute(true);
    try {
      const post = () =>
        enabled.inject({
          method: 'POST',
          url: `/v1/agents/${agentId}/test-calls`,
          headers: { 'idempotency-key': 'same-request' },
          payload: { releaseId },
        });
      const first = await post();
      expect(first.statusCode, first.body).toBe(202);
      const createdCallId = first.json().callId as string;
      await vi.waitFor(() => expect(callRows.get(createdCallId)?.status).toBe('completed'));
      expect(eventRows.get(createdCallId)?.map((row) => row.type)).toEqual([
        'fixture.request',
        'transcript.accepted',
        'fixture.usage',
        'fixture.result',
      ]);
      expect(await archive.list('workspace', createdCallId)).toEqual([]);
      expect(
        eventRows.get(createdCallId)?.find((row) => row.type === 'fixture.result')?.payload,
      ).not.toHaveProperty('recording');
      expect(usageRows).toMatchObject([{ amountMinor: '20', currency: 'INR', state: 'estimated' }]);
      await vi.waitFor(() =>
        expect(telemetryEvents.map((row) => row.kind)).toEqual([
          'session.started',
          'transcript.accepted',
          'provider.usage',
          'session.ended',
        ]),
      );
      expect(telemetryEvents.every((row) => row.source === 'test')).toBe(true);
      const evidence = await enabled.inject({
        method: 'GET',
        url: `/v1/calls/${createdCallId}/evidence`,
      });
      expect(evidence.statusCode, evidence.body).toBe(200);
      expect(evidence.json().cost).toMatchObject({
        estimatedPaise: '20',
        reconciledPaise: null,
        unpriced: [],
      });
      const exportInput = await createRecordingExportInputLoader(store)({
        workspaceId: 'workspace',
        callId: createdCallId,
        createdAt,
      } as never);
      expect(exportInput.transcript).toMatchObject([
        {
          speaker: 'customer',
          text: 'Hello',
        },
      ]);
      const second = await post();
      expect(second.statusCode, second.body).toBe(202);
      expect(second.json().callId).toBe(createdCallId);
      expect((store.createCall as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      const latestPost = () =>
        enabled.inject({
          method: 'POST',
          url: `/v1/agents/${agentId}/test-calls`,
          headers: { 'idempotency-key': 'latest-selector' },
          payload: {},
        });
      const latestFirst = await latestPost();
      expect(latestFirst.statusCode, latestFirst.body).toBe(202);
      latestRelease = { ...release, id: 'a6df7164-e5f1-432d-91c8-98c112a5e6bb' };
      const latestRetry = await latestPost();
      expect(latestRetry.statusCode, latestRetry.body).toBe(202);
      expect(latestRetry.json().callId).toBe(latestFirst.json().callId);
      expect((store.createCall as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    } finally {
      await enabled.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists both fixture recording tracks only after capture is requested', async () => {
    const directory = await mkdtemp('/var/tmp/ovo-fixture-recording-');
    const archive = new RecordingArchive(new LocalRecordingBackend(join(directory, 'objects')));
    try {
      const writer = createFixtureRecordingPort(MULAW_8K).open();
      await writer.write('caller', Uint8Array.from([0xff, 0xfe, 0xfd]), 100);
      await writer.write('agent', Uint8Array.from([0xfc, 0xfb]), 120);
      expect(await archive.list('workspace', callId)).toEqual([]);
      const saved = await persistFixtureRecording({
        context: { get: () => archive } as never,
        workspaceId: 'workspace',
        callId,
        payload: await writer.finish({ reason: 'behavior_completed', outcome: 'completed' }),
      });
      expect(saved.source).toBe('fixture');
      expect(Object.keys(saved.tracks)).toEqual(['caller', 'agent']);
      const rows = await archive.list('workspace', callId);
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(inspectWav((await archive.read('workspace', callId, row.id)).wav)).toMatchObject({
          format: 'mulaw',
          sampleRate: 8000,
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses capacity before creating a row and retries the same key after capacity returns', async () => {
    const release = { id: releaseId, agentId, config: { recording: false } };
    const rows = new Map<string, { id: string; kind: 'test'; status: string }>();
    const events = new Map<string, { type: string; payload: Record<string, unknown> }[]>();
    const store = {
      getAgent: vi.fn(async () => ({ id: agentId })),
      getRelease: vi.fn(async () => release),
      getCall: vi.fn(async (_workspace: string, id: string) => rows.get(id)),
      createCall: vi.fn(async (row: { id: string; status: string }) => {
        const saved = { ...row, kind: 'test' as const };
        rows.set(row.id, saved);
        return saved;
      }),
      appendCallEvent: vi.fn(
        async (_workspace: string, id: string, type: string, payload: Record<string, unknown>) => {
          events.set(id, [...(events.get(id) ?? []), { type, payload }]);
        },
      ),
      listCallEvents: vi.fn(async (_workspace: string, id: string) => ({
        items: events.get(id) ?? [],
        nextCursor: null,
      })),
      finishCall: vi.fn(async (_workspace: string, id: string, status: string) => {
        rows.get(id)!.status = status;
      }),
    } as unknown as ControlStore;
    const build = (maxConcurrent: number) => {
      const app = Fastify();
      registerTestCallRoutes({
        app,
        store: mockFixtureAdmission(store),
        requireRole: () => ({ workspaceId: 'workspace' }) as never,
        testCallRuntime: new TestCallRuntime({
          enabled: true,
          maxConcurrent,
          execute: async (job) => ({
            callId: job.callId,
            kind: 'test',
            status: 'completed',
            outcome: { reason: 'behavior_completed', outcome: 'completed' },
            events: [],
            selections: {},
            sttMode: 'none',
            usage: [],
            carrierFrames: [],
            compatIssues: [],
          }),
        }),
      });
      return app;
    };
    const denied = build(0);
    const request = {
      method: 'POST' as const,
      url: `/v1/agents/${agentId}/test-calls`,
      headers: { 'idempotency-key': 'retry-after-capacity' },
      payload: { releaseId },
    };
    try {
      const refused = await denied.inject(request);
      expect(refused.statusCode).toBe(429);
      expect(store.createCall).not.toHaveBeenCalled();
    } finally {
      await denied.close();
    }
    const available = build(1);
    try {
      const accepted = await available.inject(request);
      expect(accepted.statusCode, accepted.body).toBe(202);
      await vi.waitFor(() => expect(rows.get(accepted.json().callId)?.status).toBe('completed'));
    } finally {
      await available.close();
    }
  });

  it('marks a failed call terminal even when its error event cannot be persisted', async () => {
    const app = Fastify();
    const row = { id: '', kind: 'test' as const, status: 'running' };
    const store = {
      getAgent: async () => ({ id: agentId }),
      getRelease: async () => ({ id: releaseId, agentId, config: { recording: false } }),
      getCall: async () => undefined,
      createCall: async (value: { id: string }) => {
        row.id = value.id;
        return row;
      },
      appendCallEvent: async (_workspace: string, _id: string, type: string) => {
        if (type === 'fixture.error') throw new Error('event write failed');
      },
      finishCall: async (_workspace: string, _id: string, status: string) => {
        row.status = status;
      },
    } as unknown as ControlStore;
    registerTestCallRoutes({
      app,
      store: mockFixtureAdmission(store),
      requireRole: () => ({ workspaceId: 'workspace' }) as never,
      testCallRuntime: new TestCallRuntime({
        enabled: true,
        execute: async () => {
          throw new Error('child failed');
        },
      }),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/test-calls`,
        payload: { releaseId },
      });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(row.status).toBe('failed'));
    } finally {
      await app.close();
    }
  });
});
