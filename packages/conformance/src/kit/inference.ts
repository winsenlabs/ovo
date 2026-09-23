import {
  MULAW_8K,
  type Clock,
  type FixtureTemplate,
  type Inference,
  type InferenceRequest,
  type NetFixtureScript,
  type NetPort,
  type ToolDefinition,
  type UsageMeter,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, type KitCheck } from './runner.ts';

export type InferenceFactory = (env: {
  net: NetPort;
  clock: Clock;
  usage: UsageSink;
}) => Inference | Promise<Inference>;

export interface InferenceKitOptions {
  template?: FixtureTemplate;
  scripts?: NetFixtureScript[];
  tools?: ToolDefinition[];
}

export interface InferenceKitContext {
  factory: InferenceFactory;
  options: InferenceKitOptions;
}

export const KIT_WRITE_TOOL: ToolDefinition = {
  id: 'book_table',
  description: 'Book a table',
  connector: 'native',
  inputSchema: {
    type: 'object',
    required: ['party', 'time'],
    properties: { party: { type: 'integer', minimum: 1 }, time: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  effect: 'write',
  confirmation: true,
  timeoutMs: 5000,
};

function request(
  tools: ToolDefinition[],
  input: string,
  results: InferenceRequest['results'],
  signal: AbortSignal,
): InferenceRequest {
  return {
    input,
    context: 'Tables can be booked for 1 to 8 people.',
    uncertainty: 'I do not know.',
    tools,
    results,
    signal,
  };
}

function requiredKeys(tool: ToolDefinition): string[] {
  return ((tool.inputSchema as { required?: string[] }).required ?? []).filter(
    (key) => typeof key === 'string',
  );
}

export const INFERENCE_CHECKS: readonly KitCheck<InferenceKitContext>[] = [
  {
    name: 'exposes provider and model',
    async run(context) {
      const inference = await context.factory({
        net: createFixtureNet([]),
        clock: acceleratedClock(0),
        usage: () => undefined,
      });
      const f = new Failures();
      f.expect(typeof inference.provider === 'string' && inference.provider, 'provider is missing');
      f.expect(typeof inference.model === 'string' && inference.model, 'model is missing');
      return f.messages;
    },
  },
  {
    name: 'the template drives a write-tool call on the first turn, then a text answer',
    async run(context) {
      const f = new Failures();
      const tools = context.options.tools ?? [KIT_WRITE_TOOL];
      const write = tools.find((tool) => tool.effect === 'write') ?? tools[0]!;
      const scripts =
        context.options.scripts ??
        context.options.template?.({
          format: MULAW_8K,
          language: 'en-US',
          sessionId: 'kit-session',
          turns: [{ atMs: 0, say: 'book a table for two at seven' }],
          tools: tools.map((tool) => ({
            id: tool.id,
            inputSchema: tool.inputSchema,
            effect: tool.effect,
          })),
        });
      if (!scripts) return ['no fixture template or scripts were supplied'];
      const net = createFixtureNet(scripts, { clock: acceleratedClock(0) });
      const usage: UsageMeter[] = [];
      const attempts = await withEgressSentinel(async (sentinel) => {
        const inference = await context.factory({
          net,
          clock: acceleratedClock(0),
          usage: (m) => usage.push(m),
        });
        const signal = new AbortController().signal;
        const first = await inference.generate(
          request(tools, 'book a table for two at seven', [], signal),
        );
        if (
          f.expect(first.kind === 'tool', `first turn replied ${first.kind}, not a tool call`) &&
          first.kind === 'tool'
        ) {
          f.expect(first.toolId === write.id, `first turn called ${first.toolId}, not ${write.id}`);
          const input = (first.input ?? {}) as Record<string, unknown>;
          for (const key of requiredKeys(write))
            f.expect(Object.hasOwn(input, key), `tool input is missing required field ${key}`);
        }
        const result = {
          id: 'op-1',
          workspaceId: 'w1',
          sessionId: 'kit-session',
          toolId: write.id,
          input: first.kind === 'tool' ? first.input : {},
          state: 'succeeded' as const,
          result: { ok: true },
          createdAt: new Date(0).toISOString(),
        };
        const second = await inference.generate(
          request(tools, 'book a table for two at seven', [result], signal),
        );
        f.expect(
          second.kind === 'text' && second.text.trim(),
          'second turn did not answer in text',
        );
        return sentinel.attempts;
      });
      f.expect(attempts.length === 0, `network bypassed the NetPort: ${attempts.join(', ')}`);
      f.expect(usage.length > 0, 'no token usage reached the UsageSink');
      for (const meter of usage) {
        f.expect(Boolean(meter.requestId), 'usage without requestId');
        f.expect(meter.operation === 'inference', `usage operation is ${meter.operation}`);
      }
      f.add(...net.mismatches.map((error) => error.message));
      f.add(...net.pending().map((step) => `unconsumed ${step.description}`));
      return f.messages;
    },
  },
  {
    name: 'an aborted request rejects',
    async run(context) {
      const inference = await context.factory({
        net: createFixtureNet([]),
        clock: acceleratedClock(0),
        usage: () => undefined,
      });
      const controller = new AbortController();
      controller.abort(new DOMException('kit abort', 'AbortError'));
      try {
        await inference.generate(request([], 'hello', [], controller.signal));
        return ['generate resolved despite an aborted signal'];
      } catch {
        return [];
      }
    },
  },
];
