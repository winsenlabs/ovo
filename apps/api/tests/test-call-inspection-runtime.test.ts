import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
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
  it('exposes resolved selections, transcript, wall-clock latency and unpriced usage', async () => {
    const app = Fastify();
    const events = [
      {
        sequence: 1,
        type: 'engine.event',
        payload: {
          event: {
            type: 'user.transcript',
            turnId: 'turn-1',
            segmentId: 'user-1',
            text: 'What is the weather?',
            stability: 'final',
          },
        },
      },
      {
        sequence: 2,
        type: 'engine.event',
        payload: {
          event: {
            type: 'user.turn',
            turnId: 'turn-1',
            phase: 'stopped',
            input: 'speech',
          },
        },
      },
      {
        sequence: 3,
        type: 'engine.event',
        payload: {
          event: {
            type: 'timing',
            turnId: 'turn-1',
            key: 'carrier_first_audio',
            atMs: Date.parse(createdAt) + 1_000,
          },
        },
      },
      {
        sequence: 4,
        type: 'engine.event',
        payload: {
          event: {
            type: 'timing',
            turnId: 'turn-1',
            key: 'playout_ack',
            atMs: Date.parse(createdAt) + 1_200,
          },
        },
      },
      {
        sequence: 5,
        type: 'engine.event',
        payload: {
          event: {
            type: 'agent.transcript',
            segmentId: 'agent-1',
            text: 'Sunny.',
            state: 'played',
          },
        },
      },
      {
        sequence: 6,
        type: 'fixture.usage',
        payload: { key: 'fixture.tts.characters', unpriced: true },
      },
      {
        sequence: 7,
        type: 'fixture.result',
        payload: {
          selections: { tts: { id: '@fixture/tts', version: '1.2.3', exact: true } },
          sttMode: 'template',
          outcome: { outcome: 'completed', reason: 'behavior_completed' },
        },
      },
    ].map((row) => ({ ...row, id: `event-${row.sequence}`, callId, at: createdAt, epoch: 0 }));
    const store = {
      getCall: vi.fn(async () => ({
        id: callId,
        releaseId,
        workspaceId: 'workspace',
        kind: 'test',
        status: 'completed',
        createdAt,
        completedAt: createdAt,
      })),
      getRelease: vi.fn(async () => ({ id: releaseId, agentId, selections: {} })),
      listCallEvents: vi.fn(
        async (_workspace: string, _call: string, _limit: number, cursor?: string) => ({
          items: events.filter((row) => row.sequence > Number(cursor ?? 0)),
          nextCursor: null,
        }),
      ),
      listUsage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCalls: vi.fn(async () => ({ items: [], nextCursor: null })),
    };
    registerInspectionRoutes({
      app,
      store,
      z,
      Id: z.uuid(),
      requireRole: () => ({ workspaceId: 'workspace' }),
      queryPage: () => ({ limit: 50 }),
      error: (
        reply: { code(n: number): { send(v: unknown): unknown } },
        status: number,
        code: string,
      ) => reply.code(status).send({ code }),
    });
    try {
      const response = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/evidence` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        call: { id: callId, agentId, outcome: 'completed' },
        selections: { tts: { pluginId: '@fixture/tts', version: '1.2.3' } },
        transcript: [
          { type: 'transcript.user.final', text: 'What is the weather?' },
          { type: 'transcript.agent.played', text: 'Sunny.' },
        ],
        latency: [
          {
            turnId: 'turn-1',
            measuredFrom: 'user_silence',
            durationMs: 1200,
            parts: [{ ms: 1000 }, { ms: 200 }],
          },
        ],
        cost: { estimatedPaise: null, reconciledPaise: null, unpriced: ['fixture.tts.characters'] },
        sttMode: 'template',
      });
      const filtered = await app.inject({
        method: 'GET',
        url: `/v1/calls?agentId=${agentId}&engine=engine.plugin&carrier=carrier.plugin&kind=test&status=completed`,
      });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(store.listCalls).toHaveBeenCalledWith('workspace', 50, undefined, {
        order: 'desc',
        agentId,
        engine: 'engine.plugin',
        carrier: 'carrier.plugin',
        kind: 'test',
        status: 'completed',
      });
    } finally {
      await app.close();
    }
  });

  it('includes workspace-scoped live recordings in call evidence', async () => {
    const app = Fastify();
    const list = vi.fn(async () => [
      {
        id: 'recording-1',
        workspaceId: 'workspace',
        callId,
        source: 'carrier',
        state: 'available',
        failure: 'private failure',
      },
    ]);
    registerInspectionRoutes({
      app,
      z,
      Id: z.uuid(),
      store: {
        getCall: async () => ({ id: callId, releaseId, kind: 'live', createdAt }),
        getRelease: async () => ({ id: releaseId, agentId, selections: {} }),
        listCallEvents: async () => ({ items: [], nextCursor: null }),
        listUsage: async () => ({ items: [], nextCursor: null }),
      },
      ctx: { get: () => ({ live: { list } }) },
      options: { productionRecordingsEnabled: true },
      requireRole: () => ({ workspaceId: 'workspace' }),
      queryPage: () => ({ limit: 50 }),
      error: (
        reply: { code(n: number): { send(v: unknown): unknown } },
        status: number,
        code: string,
      ) => reply.code(status).send({ code }),
    });
    try {
      const response = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/evidence` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        recording: { id: 'recording-1', source: 'carrier', state: 'available' },
        recordings: [{ id: 'recording-1' }],
      });
      expect(response.body).not.toContain('private failure');
      expect(list).toHaveBeenCalledWith('workspace', callId, 100);
    } finally {
      await app.close();
    }
  });

  it('defaults off in production and keeps two in-process test slots bounded', async () => {
    expect(fixtureCallsEnabled({ nodeEnv: 'production' })).toBe(false);
    expect(fixtureCallsEnabled({ nodeEnv: 'development' })).toBe(true);
    let finish!: (value: never) => void;
    const pending = new Promise<never>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(() => pending);
    const runtime = new TestCallRuntime({ enabled: true, execute });
    const job = { callId, release: {} as never };
    const first = runtime.start(job);
    const second = runtime.start(job);
    expect(() => runtime.start(job)).toThrow('fixture_calls_capacity');
    finish({ callId, status: 'completed' } as never);
    await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runtime.activeCount).toBe(0);
  });

  it('sends a serializable job to an isolated child and waits for its event writes', async () => {
    class FakeChild extends EventEmitter {
      connected = true;
      sent: unknown[] = [];
      send(value: unknown) {
        this.sent.push(value);
        queueMicrotask(() => {
          this.emit('message', {
            type: 'event',
            event: { seq: 1, atMs: 10, event: { type: 'end', reason: 'behavior_completed' } },
          });
          this.emit('message', { type: 'result', result: { callId, status: 'completed' } });
        });
        return true;
      }
      disconnect() {
        this.connected = false;
      }
      kill() {
        return true;
      }
    }
    const child = new FakeChild();
    const forkChild = vi.fn(() => child as unknown as ChildProcess);
    const received: string[] = [];
    const runtime = new TestCallRuntime({
      enabled: true,
      modulePath: '/fake/api-index.js',
      forkChild,
    });
    const result = await runtime.start({ callId, release: {} as never }, async (row) => {
      await Promise.resolve();
      received.push(row.event.type);
    });
    expect(forkChild).toHaveBeenCalledWith('/fake/api-index.js', ['--ovo-fixture-call-child']);
    expect(child.sent).toMatchObject([{ type: 'start', job: { callId } }]);
    expect(result).toMatchObject({ callId, status: 'completed' });
    expect(received).toEqual(['end']);
    expect(child.connected).toBe(false);
  });

  it('keeps the wall timeout active while durable event writes are pending', async () => {
    class StalledChild extends EventEmitter {
      connected = true;
      send() {
        queueMicrotask(() => {
          this.emit('message', {
            type: 'event',
            event: { seq: 1, atMs: 10, event: { type: 'end', reason: 'behavior_completed' } },
          });
          this.emit('message', { type: 'result', result: { callId, status: 'completed' } });
        });
        return true;
      }
      disconnect() {
        this.connected = false;
      }
      kill() {
        return true;
      }
    }
    const child = new StalledChild();
    const runtime = new TestCallRuntime({
      enabled: true,
      modulePath: '/fake/api-index.js',
      forkChild: () => child as unknown as ChildProcess,
      wallTimeoutMs: 20,
    });
    const outcome = await Promise.race([
      runtime
        .start({ callId, release: {} as never }, () => new Promise<void>(() => {}))
        .then(
          () => 'unexpected success',
          (error: Error) => error.message,
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 200)),
    ]);
    expect(outcome).toContain('wall timeout');
    expect(runtime.activeCount).toBe(0);
  });
});
