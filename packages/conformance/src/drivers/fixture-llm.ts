import { httpJson } from '@winsendotai/ovo-plugin-kit';
import type {
  FixtureTemplate,
  Inference,
  InferenceReply,
  InferenceRequest,
  NetPort,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import { FIXTURE_DOCS, FIXTURE_HOST, FIXTURE_RETRIEVED } from './fixture-stt.ts';

const LLM_URL = `https://${FIXTURE_HOST}/v1/chat`;

/** A minimal schema-valid value for a JSON Schema (required properties only). */
export function sampleFor(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ('const' in schema) return schema.const;
  switch (schema.type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];
      return Object.fromEntries(required.map((key) => [key, sampleFor(properties[key] ?? {})]));
    }
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    default:
      return typeof schema.minLength === 'number'
        ? 'x'.repeat(Math.max(1, schema.minLength))
        : 'fixture';
  }
}

/** The fixture LLM: one JSON POST per step to https://fixture.invalid/v1/chat. */
export class FixtureInference implements Inference {
  readonly provider = 'fixture';
  readonly model = 'fixture-llm-1';
  private requests = 0;

  constructor(
    private readonly net: NetPort,
    private readonly options: { usage?: UsageSink; sessionId?: string } = {},
  ) {}

  async generate(request: InferenceRequest): Promise<InferenceReply> {
    request.signal.throwIfAborted();
    const result = await httpJson(
      this.net,
      LLM_URL,
      {
        method: 'POST',
        json: {
          input: request.input,
          results: request.results.length,
          tools: request.tools.map((t) => t.id),
        },
      },
      { timeoutMs: 10_000, signal: request.signal },
    );
    if (result.kind !== 'ok') throw new Error(`fixture LLM ${result.kind}: ${result.reason}`);
    const body = result.body;
    const requestId = String(
      body.id ?? `fixture:${this.options.sessionId ?? 'session'}:${++this.requests}`,
    );
    const usage = (body.usage ?? {}) as Record<string, number>;
    for (const [unit, quantity] of [
      ['input_tokens', usage.input_tokens],
      ['output_tokens', usage.output_tokens],
    ] as const)
      if (typeof quantity === 'number')
        this.options.usage?.({
          provider: 'fixture',
          operation: 'inference',
          unit,
          quantity: String(quantity),
          state: 'reconciled',
          requestId,
          elapsedMs: 0,
        });
    if (body.type === 'tool') return { kind: 'tool', toolId: String(body.tool), input: body.input };
    return { kind: 'text', text: String(body.text ?? '') };
  }
}

/** First user turn → a call to the first write tool (schema-valid input); then a text answer. */
export const fixtureLlmTemplate: FixtureTemplate = (input) => {
  const tool = input.tools?.find((candidate) => candidate.effect === 'write') ?? input.tools?.[0];
  const reply = (body: Record<string, unknown>) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usage: { input_tokens: 12, output_tokens: 4 }, ...body }),
  });
  const steps = [
    ...(tool
      ? [
          {
            expect: 'http' as const,
            method: 'POST',
            url: LLM_URL,
            body: 'json' as const,
            where: { results: 0 },
            reply: reply({
              id: 'fixture-llm-1',
              type: 'tool',
              tool: tool.id,
              input: sampleFor(tool.inputSchema),
            }),
          },
        ]
      : []),
    {
      expect: 'http' as const,
      method: 'POST',
      url: LLM_URL,
      body: 'json' as const,
      reply: reply({ id: 'fixture-llm-2', type: 'text', text: 'All done.' }),
    },
  ];
  return [
    { host: FIXTURE_HOST, source: `${FIXTURE_DOCS}/llm`, retrieved: FIXTURE_RETRIEVED, steps },
  ];
};
