import {
  MULAW_8K,
  type Clock,
  type FixtureTemplate,
  type Inference,
  type InferenceRequest,
  type InferenceStreamEvent,
  type NetFixtureScript,
  type NetPort,
  type ToolDefinition,
  type UsageMeter,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compileConfigSchema, runtimeAjv } from '@winsendotai/ovo-runtime';
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

const INPUT = 'book a table for two at seven';

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

const settled = (toolId: string, input: unknown): InferenceRequest['results'][number] => ({
  id: 'op-1',
  workspaceId: 'w1',
  sessionId: 'kit-session',
  toolId,
  input,
  state: 'succeeded',
  result: { ok: true },
  createdAt: new Date(0).toISOString(),
});

const toolsOf = (context: InferenceKitContext) => context.options.tools ?? [KIT_WRITE_TOOL];

function scriptsFor(
  context: InferenceKitContext,
  tools: ToolDefinition[],
): NetFixtureScript[] | undefined {
  return (
    context.options.scripts ??
    context.options.template?.({
      format: MULAW_8K,
      language: 'en-US',
      sessionId: 'kit-session',
      turns: [{ atMs: 0, say: INPUT }],
      tools: tools.map((tool) => ({
        id: tool.id,
        inputSchema: tool.inputSchema,
        effect: tool.effect,
      })),
    })
  );
}

/**
 * The tool input is validated against the tool's own JSON Schema (#F10). Checking that the
 * required keys are merely present let a model pass with `{party: 'lots', time: null}`.
 */
export function schemaFailures(tool: ToolDefinition, input: unknown): string[] {
  let check;
  try {
    check = compileConfigSchema(tool.inputSchema as Record<string, unknown>);
  } catch (error) {
    return [
      `tool ${tool.id} inputSchema does not compile: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (check(input)) return [];
  return [
    `tool input does not satisfy ${tool.id}.inputSchema: ${runtimeAjv.errorsText(check.errors)}`,
  ];
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
      const tools = toolsOf(context);
      const write = tools.find((tool) => tool.effect === 'write') ?? tools[0]!;
      const scripts = scriptsFor(context, tools);
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
        const first = await inference.generate(request(tools, INPUT, [], signal));
        if (
          f.expect(first.kind === 'tool', `first turn replied ${first.kind}, not a tool call`) &&
          first.kind === 'tool'
        ) {
          f.expect(first.toolId === write.id, `first turn called ${first.toolId}, not ${write.id}`);
          f.add(...schemaFailures(write, first.input));
        }
        const result = settled(write.id, first.kind === 'tool' ? first.input : {});
        const second = await inference.generate(request(tools, INPUT, [result], signal));
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
    /** The optional streaming path is a real surface engines use; it used to be untested (#F11). */
    name: 'stream() reaches the same decisions as generate() when it is implemented',
    async run(context) {
      const f = new Failures();
      const tools = toolsOf(context);
      const write = tools.find((tool) => tool.effect === 'write') ?? tools[0]!;
      const scripts = scriptsFor(context, tools);
      if (!scripts) return ['no fixture template or scripts were supplied'];
      const net = createFixtureNet(scripts, { clock: acceleratedClock(0) });
      const usage: UsageMeter[] = [];
      const inference = await context.factory({
        net,
        clock: acceleratedClock(0),
        usage: (m) => usage.push(m),
      });
      if (!inference.stream) return [];
      const signal = new AbortController().signal;
      const collect = async (results: InferenceRequest['results']) => {
        const events: InferenceStreamEvent[] = [];
        for await (const event of inference.stream!(request(tools, INPUT, results, signal)))
          events.push(event);
        return events;
      };
      const first = await collect([]);
      f.expect(first.length > 0, 'stream() yielded nothing on the first turn');
      f.expect(first.at(-1)?.kind === 'finish', "stream() must end with a 'finish' event");
      const call = first.find((event) => event.kind === 'tool');
      if (f.expect(call, 'stream() did not call the write tool on the first turn') && call)
        if (call.kind === 'tool') {
          f.expect(call.toolId === write.id, `stream() called ${call.toolId}, not ${write.id}`);
          f.add(...schemaFailures(write, call.input));
        }
      const second = await collect([settled(write.id, call?.kind === 'tool' ? call.input : {})]);
      const text = second
        .flatMap((event) => (event.kind === 'text-delta' ? [event.delta] : []))
        .join('');
      f.expect(text.trim(), 'stream() produced no text on the second turn');
      f.expect(second.at(-1)?.kind === 'finish', "the second stream did not end with 'finish'");
      f.expect(usage.length > 0, 'stream() reported no token usage');
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
