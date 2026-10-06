import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  readSessionEvent,
  type Behavior,
  type DecisionPort,
  type EventSink,
  type Execution,
  type Inference,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { AgentBehavior, createAgentBehaviorPlugin } from '../src/index.ts';

const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };
const variables = { outstanding: 4850 };

function config(over: Record<string, unknown> = {}) {
  return AgentConfig.parse({
    name: 'Collections',
    mode: 'agent',
    context: 'Collect the overdue EMI. Never offer a waiver.',
    uncertainty: 'Let me check that for you.',
    variables: {
      type: 'object',
      properties: {
        outstanding: { type: 'number', 'x-ovo-format': 'currency', 'x-ovo-currency': 'INR' },
      },
    },
    guardrail: { mode: 'block', safeLine: 'Let me confirm that with my team.' },
    ending: { llmTool: true },
    ...over,
  });
}

function sink() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const port: EventSink = {
    append: async (type, payload) => {
      readSessionEvent(type, payload); // every recorded event is valid for storage
      events.push({ type, payload });
    },
  };
  return { events, port };
}

function streaming(text: string): Inference {
  return {
    generate: async () => ({ kind: 'text', text }),
    async *stream(): AsyncGenerator<InferenceStreamEvent> {
      for (const word of text.split(/(?<= )/)) yield { kind: 'text-delta', delta: word };
      yield { kind: 'finish' };
    },
  };
}

async function collect(stream: AsyncIterable<string>) {
  const said: string[] = [];
  for await (const segment of stream) said.push(segment);
  return said;
}

describe('agent outcomes and the reply guardrail (AGT-8)', () => {
  it('blocks an invented offer in the streamed reply and records the turn and the verdict', async () => {
    const recorded = sink();
    const agent = new AgentBehavior(
      config(),
      streaming('Your dues are ₹4,850. I can waive ₹500 if you pay today. Shall I send a link?'),
      execution,
      { workspaceId: 'w', sessionId: 's', events: recorded.port },
    );
    expect(await collect(agent.respondStream('can you reduce it?', variables))).toEqual([
      'Your dues are ₹4,850.',
      'Let me confirm that with my team.',
    ]);
    expect(recorded.events).toEqual([
      { type: 'turn.route', payload: { turn: 1, tier: 'llm' } },
      {
        type: 'guardrail',
        payload: expect.objectContaining({
          turn: 1,
          action: 'blocked',
          findings: [
            { kind: 'amount', text: '500' },
            { kind: 'offer', text: 'waive' },
          ],
        }),
      },
    ]);
    expect(agent.guardrailMetrics.snapshot()).toMatchObject({ blocked: 1, dropped: 1 });
  });

  it('checks the non-streamed reply and the LLM goodbye too', async () => {
    const recorded = sink();
    const agent = new AgentBehavior(
      config({ guardrail: { mode: 'flag' } }),
      { generate: async () => ({ kind: 'text', text: 'Pay ₹4,000 and we settle.' }) },
      execution,
      { workspaceId: 'w', sessionId: 's', events: recorded.port },
    );
    expect(await agent.respond('hi', variables)).toBe('Pay ₹4,000 and we settle.');
    expect(recorded.events.map((event) => event.type)).toEqual(['turn.route', 'guardrail']);

    const ending = new AgentBehavior(
      config(),
      {
        generate: async () => ({
          kind: 'tool',
          toolId: 'end_call',
          input: { goodbye: 'Thanks, your 20% discount is applied. Bye!' },
        }),
      },
      execution,
      { workspaceId: 'w', sessionId: 's' },
    );
    expect(await ending.respond('bye', variables)).toBe('Let me confirm that with my team.');
  });

  it("lets the reply repeat a tool result from an earlier turn and the caller's own words", async () => {
    const replies: Awaited<ReturnType<Inference['generate']>>[] = [
      { kind: 'tool', toolId: 'balance', input: {} },
      { kind: 'text', text: 'Your balance is ₹12,345.' },
      { kind: 'text', text: 'So ₹12,345, and ₹2,000 of it on 20th October.' },
    ];
    const balance = {
      id: 'operation-1',
      workspaceId: 'w',
      sessionId: 's',
      toolId: 'balance',
      input: {},
      state: 'succeeded',
      result: { amount: 12345 },
      createdAt: new Date(0).toISOString(),
    } as const;
    const agent = new AgentBehavior(
      config({
        allowedTools: ['balance'],
        tools: [
          {
            id: 'balance',
            description: 'Read balance',
            connector: 'native',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            effect: 'read',
            confirmation: false,
            timeoutMs: 1000,
          },
        ],
      }),
      { generate: async () => replies.shift()! },
      { execute: async () => balance },
      { workspaceId: 'w', sessionId: 's' },
    );
    expect(await agent.respond('what do I owe?', variables)).toBe('Your balance is ₹12,345.');
    expect(await agent.respond('I can pay 2000 rupees on 20th October', variables)).toBe(
      'So ₹12,345, and ₹2,000 of it on 20th October.',
    );
    expect(agent.guardrailMetrics.snapshot()).toMatchObject({ blocked: 0, flagged: 0 });
  });

  it('records the decision tier for a trusted answer and never checks authored lines', async () => {
    const recorded = sink();
    const decision: DecisionPort = {
      decide: async () => ({
        modelId: 'jev-1',
        answers: {
          intent: {
            type: 'choice',
            choice: 'pay',
            confidence: 0.95,
            calibrationVersion: 'c1',
            probabilities: { pay: 0.95, other: 0.05 },
          },
        },
      }),
    };
    const agent = new AgentBehavior(
      config({
        decision: {
          enabled: true,
          state: { sources: ['last-turn'] },
          questions: [
            {
              type: 'choice',
              id: 'intent',
              instructions: 'What does the caller want?',
              threshold: 0.8,
              fallback: 'llm',
              options: [
                {
                  key: 'pay',
                  description: 'Pays',
                  outcome: { say: 'A 10% waiver link is on its way.' },
                },
                { key: 'other', description: 'Anything else', outcome: {} },
              ],
            },
          ],
        },
      }),
      streaming('unused'),
      execution,
      { workspaceId: 'w', sessionId: 's', events: recorded.port, decision },
    );
    expect(await agent.respond('I will pay', variables)).toBe('A 10% waiver link is on its way.');
    expect(recorded.events).toEqual([
      {
        type: 'turn.route',
        payload: expect.objectContaining({
          turn: 1,
          tier: 'jev',
          intent: 'intent=pay',
          confidence: 0.95,
        }),
      },
    ]);
  });

  it('leaves an agent without a guardrail exactly as it was, and composes without a sink', async () => {
    const plain = AgentConfig.parse({ name: 'Plain', mode: 'agent', context: 'facts' });
    expect(plain.guardrail).toBeUndefined();
    expect(() => AgentConfig.parse({ name: 'F', mode: 'faq', guardrail: {} })).toThrow(
      /agent mode/,
    );
    const agent = new AgentBehavior(plain, streaming('Pay ₹1 and we waive the rest.'), execution, {
      workspaceId: 'w',
      sessionId: 's',
    });
    expect(await collect(agent.respondStream('hi'))).toEqual(['Pay ₹1 and we waive the rest.']);

    const recorded = sink();
    const fixture = (key: string, value: unknown) =>
      definePlugin(
        {
          id: `fixture.${key}`,
          version: '0.1.0',
          contractVersion: 1,
          scope: 'session',
          requires: [],
          provides: [key],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        (ctx) => {
          ctx.provide(key, value);
        },
      );
    for (const withSink of [true, false]) {
      const dependencies = [
        fixture(Cap.inference, streaming('Hello.')),
        fixture(Cap.execution, execution),
        ...(withSink ? [fixture(Cap.events, recorded.port)] : []),
      ];
      const plugin = createAgentBehaviorPlugin();
      const composition = await compose(
        [
          ...dependencies.map((definition) => ({ id: definition.manifest.id })),
          { id: plugin.manifest.id, config: { agent: plain, workspaceId: 'w', sessionId: 's' } },
        ],
        [...dependencies, plugin],
      );
      try {
        const behavior = composition.ctx.get(Cap.behavior) as Behavior;
        await expect(behavior.respond('hi')).resolves.toBe('Hello.');
      } finally {
        await composition.dispose();
      }
    }
    expect(recorded.events).toEqual([{ type: 'turn.route', payload: { turn: 1, tier: 'llm' } }]);
  });
});
