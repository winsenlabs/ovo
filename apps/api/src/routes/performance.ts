import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PerformanceService } from '@winsendotai/ovo-plugin-observability';

interface ScopedPrincipal {
  workspaceId: string;
}

interface CallLookup {
  getCall(workspaceId: string, callId: string): Promise<{ id: string } | undefined>;
}

export interface PerformanceRouteOptions {
  app: FastifyInstance;
  store: CallLookup;
  performance?: PerformanceService;
  requireRole: (request: FastifyRequest, role: 'viewer') => ScopedPrincipal;
  maxSseConnections?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  maxConnectionMs?: number;
  maxSseBufferedBytes?: number;
}

const idParams = z.object({ callId: z.uuid() });
const performanceQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  bucket: z.enum(['hour', 'day']).default('hour'),
  groupBy: z.string().max(200).optional(),
  agentId: z.string().min(1).max(200).optional(),
  releaseId: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  language: z.string().min(1).max(100).optional(),
  stage: z.string().min(1).max(500).optional(),
  source: z.enum(['live', 'simulation']).optional(),
  maxGroups: z.coerce.number().int().min(1).max(200).default(100),
  callLimit: z.coerce.number().int().min(0).max(50).default(25),
});
const streamQuery = z.object({ cursor: z.coerce.number().int().min(-1).optional() });
const performanceGroup = z.enum([
  'agent',
  'release',
  'provider',
  'model',
  'language',
  'stage',
  'source',
  'time',
]);

export function registerPerformanceRoutes(options: PerformanceRouteOptions) {
  const maxConnections = bound(options.maxSseConnections ?? 100, 1, 10_000);
  const pollMs = bound(options.pollIntervalMs ?? 500, 10, 5_000);
  const heartbeatMs = bound(options.heartbeatMs ?? 15_000, 10, 60_000);
  const maxConnectionMs = bound(options.maxConnectionMs ?? 3_600_000, 100, 86_400_000);
  const maxBuffered = bound(options.maxSseBufferedBytes ?? 64 * 1024, 1_024, 1024 * 1024);
  let activeConnections = 0;

  options.app.get('/v1/performance', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = options.requireRole(request, 'viewer');
    if (!options.performance) return unavailable(reply);
    const query = performanceQuery.parse(request.query);
    const groupBy = parseGroups(query.groupBy);
    const result = await options.performance.queryPerformance(principal.workspaceId, {
      ...query,
      groupBy,
    });
    return {
      ...result,
      ingestion: options.performance.ingestionStats?.() ?? null,
    };
  });

  options.app.get(
    '/v1/calls/:callId/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = options.requireRole(request, 'viewer');
      const { callId } = idParams.parse(request.params);
      if (!(await options.store.getCall(principal.workspaceId, callId)))
        return reply.code(404).send({ error: { code: 'not_found', message: 'Call not found' } });
      if (!options.performance) return unavailable(reply);
      if (activeConnections >= maxConnections)
        return reply
          .code(429)
          .send({ error: { code: 'stream_capacity', message: 'SSE connection limit reached' } });
      const query = streamQuery.parse(request.query);
      const headerCursor = parseCursor(request.headers['last-event-id']);
      let cursor = query.cursor ?? headerCursor ?? -1;
      const controller = new AbortController();
      const onClose = () => controller.abort();
      request.raw.once('aborted', onClose);
      reply.raw.once('close', onClose);
      activeConnections++;
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      response.flushHeaders();
      const deadline = Date.now() + maxConnectionMs;
      let lastWrite = 0;
      try {
        while (!controller.signal.aborted && Date.now() < deadline) {
          const page = await options.performance.listCallEvents(
            principal.workspaceId,
            callId,
            cursor,
            100,
          );
          if (page.gap) {
            await writeSse(
              response,
              `event: gap\ndata: ${JSON.stringify(page.gap)}\n\n`,
              maxBuffered,
              controller.signal,
            );
            lastWrite = Date.now();
          }
          for (const event of page.events) {
            await writeSse(
              response,
              `id: ${event.sequence}\nevent: telemetry\ndata: ${JSON.stringify(event)}\n\n`,
              maxBuffered,
              controller.signal,
            );
            cursor = event.sequence;
            lastWrite = Date.now();
          }
          if (Date.now() - lastWrite >= heartbeatMs) {
            await writeSse(
              response,
              `: heartbeat ${Date.now()}\n\n`,
              maxBuffered,
              controller.signal,
            );
            lastWrite = Date.now();
          }
          await delay(pollMs, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted && !response.destroyed)
          response.write(
            `event: error\ndata: ${JSON.stringify({ message: safeMessage(error) })}\n\n`,
          );
      } finally {
        request.raw.off('aborted', onClose);
        reply.raw.off('close', onClose);
        activeConnections--;
        if (!response.destroyed) response.end();
      }
    },
  );

  return {
    get activeConnections() {
      return activeConnections;
    },
  };
}

function parseGroups(value?: string) {
  if (!value) return undefined;
  const groups = [...new Set(value.split(',').filter(Boolean))];
  return z.array(performanceGroup).min(1).max(8).parse(groups);
}

function parseCursor(value: string | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value) || !/^\d+$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

async function writeSse(
  response: ServerResponse,
  chunk: string,
  maxBuffered: number,
  signal: AbortSignal,
): Promise<void> {
  if (response.destroyed || signal.aborted) throw new DOMException('SSE closed', 'AbortError');
  if (response.writableLength + Buffer.byteLength(chunk) > maxBuffered)
    throw new Error('SSE client is too slow');
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained);
      response.off('close', closed);
      signal.removeEventListener('abort', closed);
      clearTimeout(timer);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new DOMException('SSE closed', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SSE backpressure deadline exceeded'));
    }, 5_000);
    response.once('drain', drained);
    response.once('close', closed);
    signal.addEventListener('abort', closed, { once: true });
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'performance_unavailable', message: 'Performance telemetry is not configured' },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Telemetry stream failed';
}

function bound(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Expected integer from ${minimum} to ${maximum}`);
  return value;
}
