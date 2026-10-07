import type { InferenceRequest, NetPort } from '@winsendotai/ovo-contracts';
import { sse } from './web-search-fixtures.ts';

/**
 * Wire format of a streamed Responses search, per
 * https://developers.openai.com/api/reference/resources/responses/streaming-events (retrieved
 * 2026-10-07): the `web_search_call` item arrives in `response.output_item.added` with status
 * `in_progress` before the search runs, and again, with its `action` (and `sources` when
 * `include: ["web_search_call.action.sources"]` asked for them), in `response.output_item.done`.
 * The `response.web_search_call.{in_progress,searching,completed}` events the AI SDK ignores are
 * left out; that page does not list them (UNCONFIRMED on the wire).
 */
export const created = (id: string) =>
  sse({ type: 'response.created', response: { id, created_at: 0, model: 'gpt-6-luna' } });

export const searchAdded = (id = 'ws-1', outputIndex = 0) =>
  sse({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'web_search_call', id, status: 'in_progress' },
  });

export const searchDone = (id = 'ws-1', outputIndex = 0, sources = 3) =>
  sse({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'web_search_call',
      id,
      status: 'completed',
      action: {
        type: 'search',
        query: 'Zagreb weather December',
        sources: Array.from({ length: sources }, (_, index) => ({
          type: 'url',
          url: `https://example.org/${index}`,
        })),
      },
    },
  });

export const answer = (text: string, outputIndex = 1) =>
  sse({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'message', id: 'msg-1' },
  }) +
  sse({
    type: 'response.output_text.delta',
    item_id: 'msg-1',
    output_index: outputIndex,
    delta: text,
  });

export const completed = (
  id: string,
  usage: { input: number; cached: number; output?: number } = { input: 900, cached: 0 },
) =>
  sse({
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: usage.input,
        input_tokens_details: { cached_tokens: usage.cached },
        output_tokens: usage.output ?? 20,
        total_tokens: usage.input + (usage.output ?? 20),
      },
    },
  });

/**
 * A provider whose streamed replies are written chunk by chunk by the test (`push`), so it can
 * observe what the inference reported before the rest of the response arrived. A request's stream
 * fails once its signal aborts, as fetch does. Every request body is recorded.
 */
export function steppedNet() {
  const bodies: Record<string, unknown>[] = [];
  const writers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const net: NetPort = {
    async fetch(_url, init) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          writers.push(controller);
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    websocket() {
      throw new Error('not used');
    },
  };
  const push = (chunk: string, request = writers.length - 1) =>
    writers[request]!.enqueue(encoder.encode(chunk));
  const end = (request = writers.length - 1) => writers[request]!.close();
  return { net, bodies, push, end, requests: () => writers.length };
}

/** A Maya-like turn: the trip companion's context, one earlier exchange and the caller's words. */
export function tripRequest(
  input: string,
  signal = new AbortController().signal,
): InferenceRequest {
  return {
    input,
    history: [
      { role: 'assistant', content: "Hi! I'm Maya, your Europe trip companion. Where to?" },
      { role: 'user', content: 'We are planning to go to Zagreb this time.' },
      {
        role: 'assistant',
        content: 'Zagreb is a lovely, walkable capital. How many days will you spend there?',
      },
    ],
    context: 'A friendly Europe trip companion on a phone call. Keep answers short.',
    uncertainty: 'I am not sure about that.',
    tools: [],
    results: [],
    signal,
  };
}

/** Lets the stream's pending reads and the SDK's transforms run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
