import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { streamEventName, type PerformanceService } from '@winsendotai/ovo-plugin-observability';
import type { Page, StoredCallEvent } from '@winsendotai/ovo-plugin-storage';
import { delay, parseCursor, writeSse } from './sse.ts';

interface ScopedPrincipal {
  workspaceId: string;
}

interface CallLookup {
  getCall(workspaceId: string, callId: string): Promise<{ id: string } | undefined>;
  listCallEvents(
    workspaceId: string,
    callId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<StoredCallEvent>>;
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
const turnParams = z.object({ callId: z.string().min(1).max(200) });
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
  source: z.enum(['live', 'simulation', 'test']).optional(),
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

  /** Per-turn stage breakdown: endpointing, decision, LLM, TTS and first carrier audio. */
  options.app.get(
    '/v1/calls/:callId/turns',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = options.requireRole(request, 'viewer');
      const { callId } = turnParams.parse(request.params);
      if (!(await options.store.getCall(principal.workspaceId, callId)))
        return reply.code(404).send({ error: { code: 'not_found', message: 'Call not found' } });
      const turns = await options.performance?.listCallTurns?.(principal.workspaceId, callId);
      if (!turns) return unavailable(reply);
      return { callId, turns };
    },
  );

  options.app.get(
    '/v1/calls/:callId/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = options.requireRole(request, 'viewer');
      const { callId } = idParams.parse(request.params);
      if (!(await options.store.getCall(principal.workspaceId, callId)))
        return reply.code(404).send({ error: { code: 'not_found', message: 'Call not found' } });
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
          const page = await options.store.listCallEvents(
            principal.workspaceId,
            callId,
            100,
            String(Math.max(0, cursor)),
          );
          for (const event of page.items) {
            if (event.sequence > Math.max(0, cursor) + 1)
              await writeSse(
                response,
                `event: gap\ndata: ${JSON.stringify({ expected: Math.max(0, cursor) + 1, actual: event.sequence })}\n\n`,
                maxBuffered,
                controller.signal,
              );
            await writeSse(
              response,
              `id: ${event.sequence}\nevent: ${streamEventName(event)}\ndata: ${JSON.stringify(event)}\n\n`,
              maxBuffered,
              controller.signal,
            );
            cursor = event.sequence;
            lastWrite = Date.now();
          }
          if (Date.now() - lastWrite >= heartbeatMs) {
            await writeSse(
              response,
              'event: heartbeat\ndata: {}\n\n',
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
