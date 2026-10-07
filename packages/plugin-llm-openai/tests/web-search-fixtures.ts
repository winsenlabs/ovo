import type { InferenceRequest, NetPort, ToolDefinition } from '@winsendotai/ovo-contracts';
import type { OpenAiInferenceConfig } from '../src/inference.ts';

export const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
/** A provider that records every request body and answers each with the next scripted reply. */
export function scriptedNet(...replies: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const net: NetPort = {
    async fetch(_url, init) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return replies[Math.min(bodies.length - 1, replies.length - 1)]!();
    },
    websocket() {
      throw new Error('not used');
    },
  };
  return { net, bodies };
}

export const plain = () =>
  new Response(
    JSON.stringify({
      id: 'resp-1',
      created_at: 0,
      model: 'gpt-6-luna',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg-1',
          content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

export const request = (tools: ToolDefinition[] = []): InferenceRequest => ({
  input: 'What is the weather in Bengaluru today?',
  context: 'A city helpline agent.',
  uncertainty: 'I am not sure.',
  tools,
  results: [],
  signal: new AbortController().signal,
});

export const lookup: ToolDefinition = {
  id: 'lookup_ticket',
  description: 'Look up a ticket',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  connector: 'native',
  effect: 'read',
  confirmation: false,
  timeoutMs: 5000,
};

export const enabled: OpenAiInferenceConfig = { model: 'gpt-6-luna', webSearch: { enabled: true } };
