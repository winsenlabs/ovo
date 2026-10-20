import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** The numeric cursor a client resumes from (`Last-Event-ID` or `?cursor=`), or undefined. */
export function parseCursor(value: string | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value) || !/^\d+$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

/**
 * Writes one SSE chunk, waiting for `drain` when the socket is full. A client too slow to keep up
 * (more than `maxBuffered` queued, or no drain within five seconds) is cut off rather than held.
 */
export async function writeSse(
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

/** Resolves after `milliseconds`, or at once when `signal` aborts. */
export function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
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

export interface SseConnection {
  response: ServerResponse;
  signal: AbortSignal;
  /** Ends the response once, whatever closed it. */
  end(): void;
}

/** Takes over the reply as an event stream; aborts `signal` when the client goes away. */
export function openSse(request: FastifyRequest, reply: FastifyReply): SseConnection {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  request.raw.once('aborted', onClose);
  reply.raw.once('close', onClose);
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  return {
    response,
    signal: controller.signal,
    end() {
      request.raw.off('aborted', onClose);
      reply.raw.off('close', onClose);
      if (!response.destroyed) response.end();
    },
  };
}
