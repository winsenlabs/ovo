import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { PerformanceService } from '@winsendotai/ovo-plugin-observability';
import type { Page, StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import { registerPerformanceRoutes } from '../src/routes/performance.ts';

const callId = '20a1422f-2905-420d-b97b-215918dc07f9';
const servers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function event(sequence: number): StoredCallEvent {
  return {
    id: `event-${sequence}`,
    callId,
    sequence,
    at: '2026-09-20T12:00:00.000Z',
    type: 'engine.event',
    epoch: 0,
    payload: {
      event: {
        type: 'user.transcript',
        turnId: 'turn-1',
        segmentId: 'segment-1',
        text: 'Hello',
        stability: 'final',
      },
    },
  };
}

function build(
  performance?: PerformanceService,
  listEvents: (_cursor?: string) => Promise<Page<StoredCallEvent>> = async () => ({
    items: [],
    nextCursor: null,
  }),
) {
  const app = Fastify({ logger: false });
  const registration = registerPerformanceRoutes({
    app,
    performance,
    store: {
      async getCall(_workspaceId, requested) {
        return requested === callId ? { id: callId } : undefined;
      },
      async listCallEvents(_workspaceId, _callId, _limit, cursor) {
        return listEvents(cursor);
      },
    },
    requireRole(request) {
      if (request.headers.authorization !== 'Bearer viewer') throw new Error('unauthorized');
      return { workspaceId: 'workspace' };
    },
    pollIntervalMs: 10,
    heartbeatMs: 20,
    maxConnectionMs: 2_000,
  });
  servers.push(app);
  return { app, registration };
}

describe('performance and resumable SSE routes', () => {
  it('returns the per-turn breakdown for a call in the caller workspace', async () => {
    const requested: string[] = [];
    const turn = { turnId: 'turn-1', endpointMs: 640, firstAudioMs: 2_130, userText: null };
    const performance: PerformanceService = {
      queryPerformance: async () => {
        throw new Error('not used');
      },
      listCallEvents: async () => ({ events: [], nextCursor: 0, gap: null }),
      listCallTurns: async (workspaceId, id) => {
        requested.push(`${workspaceId}/${id}`);
        return [turn as never];
      },
    };
    const { app } = build(performance);
    const headers = { authorization: 'Bearer viewer' };
    const found = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/turns`, headers });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ callId, turns: [turn] });
    expect(requested).toEqual([`workspace/${callId}`]);
    const missing = await app.inject({ method: 'GET', url: '/v1/calls/other-call/turns', headers });
    expect(missing.statusCode).toBe(404);
    const unavailable = await build().app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/turns`,
      headers,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(requested).toHaveLength(1);
  });

  it('returns explicit unavailability rather than fabricated performance data', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/performance?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z',
      headers: { authorization: 'Bearer viewer' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('performance_unavailable');
  });

  it('queries scoped cohorts and resumes SSE from persisted sequence with gap and abort cleanup', async () => {
    const requestedCursors: string[] = [];
    const performance: PerformanceService = {
      async queryPerformance(_workspaceId, query) {
        return {
          from: query.from,
          to: query.to,
          bucket: query.bucket,
          groups: [],
          truncated: false,
        };
      },
      async listCallEvents(_workspaceId, _callId, cursor) {
        return { events: [], nextCursor: cursor, gap: null };
      },
    };
    const { app, registration } = build(performance, async (cursor) => {
      requestedCursors.push(cursor ?? '');
      if (cursor === '0') return { items: [event(2)], nextCursor: null };
      if (cursor === '2') return { items: [event(3)], nextCursor: null };
      return { items: [], nextCursor: null };
    });
    const aggregate = await app.inject({
      method: 'GET',
      url: '/v1/performance?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z&groupBy=provider,stage',
      headers: { authorization: 'Bearer viewer' },
    });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json()).toMatchObject({ groups: [], ingestion: null });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const first = await readAndAbortSse(
      `${address}/v1/calls/${callId}/stream?cursor=0`,
      { authorization: 'Bearer viewer' },
      'id: 2',
    );
    expect(first.status).toBe(200);
    expect(first.text).toContain('event: gap');
    expect(first.text).toContain('"expected":1');
    await waitFor(() => registration.activeConnections === 0);

    const resumed = await readAndAbortSse(
      `${address}/v1/calls/${callId}/stream`,
      { authorization: 'Bearer viewer', 'last-event-id': '2' },
      'id: 3',
    );
    expect(resumed.text).not.toContain('id: 2');
    await waitFor(() => registration.activeConnections === 0);
    expect(requestedCursors).toContain('0');
    expect(requestedCursors).toContain('2');
  });

  it('sends an observable named heartbeat while a call has no new events', async () => {
    const performance: PerformanceService = {
      async queryPerformance(_workspaceId, query) {
        return {
          from: query.from,
          to: query.to,
          bucket: query.bucket,
          groups: [],
          truncated: false,
        };
      },
      async listCallEvents(_workspaceId, _callId, cursor) {
        return { events: [], nextCursor: cursor, gap: null };
      },
    };
    const { app, registration } = build(performance);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const stream = await readAndAbortSse(
      `${address}/v1/calls/${callId}/stream`,
      { authorization: 'Bearer viewer' },
      'event: heartbeat\ndata: {}',
    );
    expect(stream.status).toBe(200);
    expect(stream.text).toContain('event: heartbeat\ndata: {}');
    await waitFor(() => registration.activeConnections === 0);
  });
});

function readAndAbortSse(
  url: string,
  headers: Record<string, string>,
  needle: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(url, { headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (settled || !text.includes(needle)) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, text });
        response.destroy();
        request.destroy();
      });
      response.on('error', (error) => {
        if (!settled) reject(error);
      });
      response.on('end', () => {
        if (!settled) reject(new Error(`SSE ended before ${needle}`));
      });
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
