import { MULAW_8K, type FixtureTemplate, type NetFixtureScript } from '@winsendotai/ovo-contracts';

const ID = '@winsendotai/ovo-provider-openai-inference';
const SOURCE = 'https://platform.openai.com/docs/api-reference/responses';
const STREAM_SOURCE = 'https://platform.openai.com/docs/api-reference/responses-streaming';

function firstWrite(input: Parameters<FixtureTemplate>[0]) {
  const tool = input.tools?.find((entry) => entry.effect === 'write');
  if (!tool) throw new TypeError('OpenAI fixture requires a write tool');
  return tool;
}

function sampleFor(schema: Record<string, unknown>): unknown {
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const alternative = (schema.oneOf ?? schema.anyOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(alternative) && alternative.length) return sampleFor(alternative[0]!);
  switch (schema.type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = Array.isArray(schema.required) ? schema.required as string[] : [];
      return Object.fromEntries(required.map((key) => [key, sampleFor(properties[key] ?? {})]));
    }
    case 'array': {
      const item = (schema.items ?? {}) as Record<string, unknown>;
      const count = typeof schema.minItems === 'number' ? Math.max(0, schema.minItems) : 0;
      return Array.from({ length: count }, () => sampleFor(item));
    }
    case 'integer':
    case 'number': {
      const minimum = typeof schema.minimum === 'number' ? schema.minimum : 1;
      const exclusive = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
      const step = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : 1;
      const bound = Math.max(minimum, exclusive === undefined ? minimum : exclusive + step);
      return schema.type === 'integer' ? Math.ceil(bound / step) * step : bound;
    }
    case 'boolean': return true;
    case 'null': return null;
    default: {
      if (schema.format === 'email') return 'fixture@example.com';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      const length = typeof schema.minLength === 'number' ? Math.max(1, schema.minLength) : 1;
      return 'x'.repeat(length);
    }
  }
}

function schemaInput(schema: Record<string, unknown>): Record<string, unknown> {
  const input = sampleFor(schema);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('OpenAI write-tool fixture requires an object input schema');
  return input as Record<string, unknown>;
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

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: openAiStreamTemplate({
    format: MULAW_8K, language: 'en', sessionId: 'fixture',
    turns: [{ atMs: 0, say: 'Book a table' }],
    tools: [{ id: 'book_table', effect: 'write', inputSchema: {
      type: 'object', required: ['party', 'time'], additionalProperties: false,
      properties: { party: { type: 'integer', minimum: 1 }, time: { type: 'string', minLength: 1 } },
    } }],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: openAiStreamTemplate };
