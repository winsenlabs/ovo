import { describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  type Execution,
  type Behavior,
  type Inference,
  type InferenceReply,
  type OperationRecord,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import {
  AgentToolSelectionError,
  ContextBudgetExceededError,
  createAgentBehavior,
  createAnnouncementBehavior,
  createAnnouncementBehaviorPlugin,
  createContextBehavior,
  createContextBehaviorPlugin,
  createFaqBehavior,
  createFaqBehaviorPlugin,
  createAgentBehaviorPlugin,
} from './index.ts';

function agent(overrides: Record<string, unknown>) {
  return AgentConfig.parse({ name: 'Fixture', mode: 'announcement', ...overrides });
}

describe('announcement behavior', () => {
  it('validates required values and formats approved date/currency paths without a model', async () => {
    const behavior = createAnnouncementBehavior(
      agent({
        mode: 'announcement',
        locale: 'en-IN',
        timezone: 'Asia/Kolkata',
        message: 'Payment of {{payment.amount}} is due on {{payment.date}}.',
        variables: {
          type: 'object',
          required: ['payment'],
          additionalProperties: false,
          properties: {
            payment: {
              type: 'object',
              required: ['amount', 'date'],
              additionalProperties: false,
              properties: {
                amount: { type: 'number', 'x-ovo-format': 'currency', 'x-ovo-currency': 'INR' },
                date: { type: 'string', format: 'date' },
              },
            },
          },
        },
      }),
    );

    await expect(
      behavior.respond('', { payment: { amount: 1234.5, date: '2026-09-20' } }),
    ).resolves.toBe('Payment of ₹1,234.50 is due on 20 September 2026.');
    await expect(behavior.respond('', { payment: { amount: 1234.5 } })).rejects.toThrow(
      /schema validation/,
    );
  });

  it('rejects expression and prototype paths', () => {
    expect(() =>
      createAnnouncementBehavior(
        agent({
          message: '{{customer.constructor.name}}',
          variables: { type: 'object', properties: { customer: { type: 'object' } } },
        }),
      ),
    ).toThrow(/Unsafe/);
    expect(() =>
      createAnnouncementBehavior(
        agent({
          message: '{{amount + tax}}',
          variables: {
            type: 'object',
            properties: { amount: { type: 'number' }, tax: { type: 'number' } },
          },
        }),
      ),
    ).toThrow(/Unsafe|unsupported/);
  });
});

describe('FAQ behavior', () => {
  const config = agent({
    mode: 'faq',
    clarification: 'Please clarify.',
    faqThreshold: 0.6,
    faqMargin: 0.2,
    faq: [
      {
        id: 'later',
        question: 'Can I pay later?',
        aliases: ['defer payment'],
        answer: 'You can request an extension.',
        requiresTool: 'eligibility',
      },
      {
        id: 'methods',
        question: 'How can I pay?',
        aliases: ['payment methods'],
        answer: 'Use card or bank transfer.',
      },
      { id: 'office', question: 'What are office hours?', aliases: [], answer: 'Nine to five.' },
    ],
  });

  it('uses deterministic threshold/margin and refuses tool-dependent approval', async () => {
    const behavior = createFaqBehavior(config);
    expect(behavior.match('payment')).toMatchObject({ kind: 'clarify', reason: 'ambiguous' });
    expect(behavior.match('Can I pay later?')).toMatchObject({
      kind: 'clarify',
      reason: 'requires-tool',
      toolId: 'eligibility',
    });
    await expect(behavior.respond('office hours')).resolves.toBe('Nine to five.');
  });

  it('treats negation mismatch conservatively', () => {
    const behavior = createFaqBehavior(
      agent({
        mode: 'faq',
        faqThreshold: 0.5,
        faqMargin: 0.1,
        faq: [{ id: 'allowed', question: 'Can I carry baggage?', answer: 'Yes.', aliases: [] }],
      }),
    );
    expect(behavior.match('Can I not carry baggage?')).toMatchObject({
      kind: 'clarify',
      reason: 'no-match',
    });
  });
});

describe('context and agent behavior', () => {
  it('fails over-budget supplied context before making inference requests', () => {
    const generate = vi.fn();
    expect(() =>
      createContextBehavior(agent({ mode: 'context', context: 'abcdef', contextBudget: 5 }), {
        generate,
      }),
    ).toThrow(ContextBudgetExceededError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps the bounded agent loop as sole continuation owner and uses Execution only', async () => {
    const replies: InferenceReply[] = [
      { kind: 'tool', toolId: 'balance', input: { account: 'A-1' } },
      { kind: 'text', text: 'Your balance is ₹500.' },
    ];
    const inference: Inference = { generate: vi.fn(async () => replies.shift()!) };
    const operation: OperationRecord = {
      id: 'operation-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      toolId: 'balance',
      input: { account: 'A-1' },
      state: 'succeeded',
      result: { amount: 500 },
      createdAt: new Date(0).toISOString(),
    };
    const execution: Execution = { execute: vi.fn(async () => operation) };
    const behavior = createAgentBehavior(
      agent({
        mode: 'agent',
        context: 'Balances come from the approved tool.',
        maxSteps: 3,
        allowedTools: ['balance'],
        tools: [
          {
            id: 'balance',
            description: 'Read balance',
            connector: 'native',
            inputSchema: {
              type: 'object',
              required: ['account'],
              properties: { account: { type: 'string' } },
              additionalProperties: false,
            },
            effect: 'read',
            confirmation: false,
            timeoutMs: 1000,
          },
        ],
      }),
      inference,
      execution,
      { workspaceId: 'workspace-1', sessionId: 'session-1', operationId: () => 'operation-1' },
    );

    await expect(behavior.respond('What is my balance?')).resolves.toBe('Your balance is ₹500.');
    expect(execution.execute).toHaveBeenCalledOnce();
    expect(execution.execute).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'balance', id: 'operation-1' }),
    );
    expect(inference.generate).toHaveBeenCalledTimes(2);
    expect((inference.generate as ReturnType<typeof vi.fn>).mock.calls[1][0].results).toEqual([
      operation,
    ]);
  });

  it('rejects an unapproved tool before Execution', async () => {
    const inference: Inference = {
      generate: async () => ({ kind: 'tool', toolId: 'unknown', input: {} }),
    };
    const execution: Execution = { execute: vi.fn() };
    const behavior = createAgentBehavior(
      agent({ mode: 'agent', maxSteps: 1 }),
      inference,
      execution,
      {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        operationId: () => 'operation-1',
      },
    );
    await expect(behavior.respond('Do it')).rejects.toBeInstanceOf(AgentToolSelectionError);
    expect(execution.execute).not.toHaveBeenCalled();
    expect(behavior.toolErrors).toMatchObject([
      { toolId: 'unknown', kind: 'unknown-or-unapproved' },
    ]);
  });

  it('declares no inference dependency for deterministic plugins', () => {
    expect(createAnnouncementBehaviorPlugin().manifest.requires).toEqual([]);
    expect(createFaqBehaviorPlugin().manifest.requires).toEqual([]);
  });

  it('composes all four modes through the shared plugin foundation', async () => {
    const inferencePlugin = definePlugin(
      {
        id: 'fixture.inference',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'session',
        requires: [],
        provides: ['ovo.inference'],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide('ovo.inference', {
          generate: async () => ({ kind: 'text', text: 'generated fixture' }),
        } satisfies Inference);
      },
    );
    const executionPlugin = definePlugin(
      {
        id: 'fixture.execution',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'session',
        requires: [],
        provides: ['ovo.execution'],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide('ovo.execution', {
          execute: async () => {
            throw new Error('not expected');
          },
        } satisfies Execution);
      },
    );

    const cases = [
      {
        definition: createAnnouncementBehaviorPlugin(),
        config: { agent: agent({ mode: 'announcement', message: 'hello' }) },
        dependencies: [],
        expected: 'hello',
      },
      {
        definition: createFaqBehaviorPlugin(),
        config: {
          agent: agent({
            mode: 'faq',
            faq: [{ id: 'hours', question: 'office hours', answer: 'Nine to five.', aliases: [] }],
          }),
        },
        dependencies: [],
        input: 'office hours',
        expected: 'Nine to five.',
      },
      {
        definition: createContextBehaviorPlugin(),
        config: { agent: agent({ mode: 'context', context: 'fixture facts' }) },
        dependencies: [inferencePlugin],
        expected: 'generated fixture',
      },
      {
        definition: createAgentBehaviorPlugin(),
        config: {
          agent: agent({ mode: 'agent', context: 'fixture facts' }),
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
        },
        dependencies: [inferencePlugin, executionPlugin],
        expected: 'generated fixture',
      },
    ];

    for (const testCase of cases) {
      const rows = [
        ...testCase.dependencies.map((definition) => ({ id: definition.manifest.id })),
        { id: testCase.definition.manifest.id, config: testCase.config },
      ];
      const composition = await compose(rows, [...testCase.dependencies, testCase.definition]);
      try {
        const behavior = composition.ctx.get('ovo.behavior') as Behavior;
        await expect(behavior.respond(testCase.input ?? 'hello')).resolves.toBe(testCase.expected);
      } finally {
        await composition.dispose();
      }
    }
  });
});
