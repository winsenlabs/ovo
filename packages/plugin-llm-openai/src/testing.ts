import { type FixtureTemplate, type NetFixtureScript } from '@winsendotai/ovo-contracts';

const ID = '@winsendotai/ovo-provider-openai-inference';
const SOURCE = 'https://platform.openai.com/docs/api-reference/responses';
const STREAM_SOURCE = 'https://platform.openai.com/docs/api-reference/responses-streaming';

function firstWrite(input: Parameters<FixtureTemplate>[0]) {
  const tool = input.tools?.find((entry) => entry.effect === 'write');
  if (!tool) throw new TypeError('OpenAI fixture requires a write tool');
  return tool;
}

function schemaInput(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  return Object.fromEntries(required.map((key) => [
    key,
    properties[key]?.type === 'integer' || properties[key]?.type === 'number' ? 2 : 'seven',
  ]));
}

function reply(output: unknown[], index: number): string {
  return JSON.stringify({
    id: `resp-fixture-${index}`, created_at: 0, model: 'gpt-4o-mini', output,
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  });
}

export const openAiGenerateTemplate: FixtureTemplate = (input): NetFixtureScript[] => {
  const tool = firstWrite(input);
  return [{
    host: 'api.openai.com', source: SOURCE, retrieved: '2026-09-25',
    steps: [
      { expect: 'http', method: 'POST', url: 'https://api.openai.com/v1/responses',
        headers: { authorization: 'Bearer fixture-key' }, body: 'json',
        reply: { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'llm-fixture-1' },
          body: reply([{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: tool.id,
            arguments: JSON.stringify(schemaInput(tool.inputSchema)) }], 1) } },
      { expect: 'http', method: 'POST', url: 'https://api.openai.com/v1/responses',
        headers: { authorization: 'Bearer fixture-key' }, body: 'json',
        reply: { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'llm-fixture-2' },
          body: reply([{ type: 'message', role: 'assistant', id: 'msg-2',
            content: [{ type: 'output_text', text: 'The table is booked.', annotations: [] }] }], 2) } },
    ],
  }];
};

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const complete = (id: string) => sse({ type: 'response.completed', response: {
  id, usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
} });

export const openAiStreamTemplate: FixtureTemplate = (input): NetFixtureScript[] => {
  const tool = firstWrite(input);
  const call = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: tool.id,
    arguments: JSON.stringify(schemaInput(tool.inputSchema)) };
  return [{
    host: 'api.openai.com', source: STREAM_SOURCE, retrieved: '2026-09-25',
    steps: [
      { expect: 'http', method: 'POST', url: 'https://api.openai.com/v1/responses',
        headers: { authorization: 'Bearer fixture-key' }, body: 'json', where: { stream: true },
        reply: { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'llm-fixture-1' },
          body: sse({ type: 'response.created', response: { id: 'resp-fixture-1', created_at: 0, model: 'gpt-4o-mini' } }) +
            sse({ type: 'response.output_item.added', output_index: 0, item: call }) +
            sse({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc-1', name: tool.id, arguments: call.arguments }) +
            sse({ type: 'response.output_item.done', output_index: 0, item: { ...call, status: 'completed' } }) +
            complete('resp-fixture-1') } },
      { expect: 'http', method: 'POST', url: 'https://api.openai.com/v1/responses',
        headers: { authorization: 'Bearer fixture-key' }, body: 'json', where: { stream: true },
        reply: { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'llm-fixture-2' },
          body: sse({ type: 'response.created', response: { id: 'resp-fixture-2', created_at: 0, model: 'gpt-4o-mini' } }) +
            sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-2' } }) +
            sse({ type: 'response.output_text.delta', item_id: 'msg-2', output_index: 0, delta: 'The table is booked.' }) +
            complete('resp-fixture-2') } },
    ],
  }];
};

export const fixtures: Record<string, NetFixtureScript[]> = {};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: openAiStreamTemplate };
