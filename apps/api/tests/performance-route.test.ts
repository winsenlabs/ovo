import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { PerformanceService } from '@winsendotai/ovo-plugin-observability';
import { registerPerformanceRoutes } from '../src/routes/performance.ts';

const callId = '20a1422f-2905-420d-b97b-215918dc07f9';
const servers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function event(sequence: number) {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${sequence}`,
    workspaceId: 'workspace',
    callId,
    sequence,
    occurredAt: '2026-09-20T12:00:00.000Z',
    ingestedAt: '2026-09-20T12:00:01.000Z',
    source: 'live' as const,
    kind: 'session.started' as const,
  };
}

function build(performance?: PerformanceService) {
  const app = Fastify({ logger: false });
  const registration = registerPerformanceRoutes({
    app,
    performance,
    store: {
      async getCall(_workspaceId, requested) {
        return requested === callId ? { id: callId } : undefined;
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
    const requestedCursors: number[] = [];
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
        requestedCursors.push(cursor);
        if (cursor === 0)
          return { events: [event(2)], nextCursor: 2, gap: { expected: 1, actual: 2 } };
        if (cursor === 2) return { events: [event(3)], nextCursor: 3, gap: null };
        return { events: [], nextCursor: cursor, gap: null };
      },
    };
    const { app, registration } = build(performance);
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
    expect(requestedCursors).toContain(0);
    expect(requestedCursors).toContain(2);
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
