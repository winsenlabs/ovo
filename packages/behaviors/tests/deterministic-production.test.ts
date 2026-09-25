import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  ScriptGraph,
  type Execution,
  type OperationRecord,
} from '@winsendotai/ovo-contracts';
import { ExecutingFaqBehavior, ScriptBehavior } from '../src/index.ts';

const config = () =>
  AgentConfig.parse({
    name: 'Script',
    mode: 'faq',
    script: {
      start: 'start',
      nodes: [
        {
          id: 'start',
          prompt: 'Press one.',
          transitions: [{ event: 'dtmf', matches: ['1'], to: 'done' }],
        },
        { id: 'done', prompt: 'Thank you.', terminal: true },
      ],
    },
    faq: [{ id: 'hours', question: 'opening hours', answer: 'Nine to five.' }],
  });
const receipt = (
  text: string,
  epoch: number,
  state: 'completed' | 'interrupted' = 'completed',
) => ({ id: crypto.randomUUID(), text, epoch, state, evidence: 'confirmed' as const });

describe('deterministic script state', () => {
  it('commits transitions only after matching playback and ignores stale receipts', async () => {
    const behavior = new ScriptBehavior(config());
    behavior.beginTurn(0);
    expect(await behavior.respond('')).toBe('Press one.');
    behavior.onPlayback(receipt('Press one.', 0));
    behavior.beginTurn(1);
    expect(await behavior.respond('1', { inputEvent: 'dtmf' })).toBe('Thank you.');
    expect(behavior.state).toBe('start');
    behavior.onPlayback(receipt('Thank you.', 0));
    expect(behavior.state).toBe('start');
    behavior.onPlayback(receipt('Thank you.', 1, 'interrupted'));
    expect(behavior.state).toBe('start');
    behavior.beginTurn(2);
    await behavior.respond('1', { inputEvent: 'dtmf' });
    behavior.onPlayback(receipt('Thank you.', 2));
    expect(behavior.state).toBe('done');
    behavior.beginTurn(3);
    expect(await behavior.respond('anything')).toBe('');
  });

  it('answers an FAQ detour and resumes the same script prompt', async () => {
    const behavior = new ScriptBehavior(config(), { respond: async () => 'Nine to five.' });
    behavior.beginTurn(0);
    await behavior.respond('');
    behavior.onPlayback(receipt('Press one.', 0));
    behavior.beginTurn(1);
    expect(await behavior.respond('opening hours')).toBe('Nine to five. Press one.');
    behavior.onPlayback(receipt('Nine to five. Press one.', 1));
    expect(behavior.state).toBe('start');
  });

  it('validates references, ambiguous matches, reachability and terminal edges', () => {
    const valid = config().script!;
    expect(ScriptGraph.safeParse({ ...valid, start: 'missing' }).success).toBe(false);
    expect(
      ScriptGraph.safeParse({ ...valid, nodes: [...valid.nodes, { id: 'orphan', prompt: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      ScriptGraph.safeParse({
        ...valid,
        nodes: [
          {
            ...valid.nodes[0],
            transitions: [{ event: 'text', matches: ['YES', 'yes'], to: 'done' }],
          },
          valid.nodes[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      ScriptGraph.safeParse({
        ...valid,
        nodes: [{ ...valid.nodes[0], terminal: true }, valid.nodes[1]],
      }).success,
    ).toBe(false);
  });

  it('rejects replayed epochs and stale FAQ completions', async () => {
    let resolve!: (text: string) => void;
    const behavior = new ScriptBehavior(config(), {
      respond: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    behavior.beginTurn(0);
    await behavior.respond('');
    behavior.onPlayback(receipt('Press one.', 0));
    behavior.beginTurn(1);
    const response = behavior.respond('hours');
    behavior.cancel();
    resolve('old answer');
    await expect(response).rejects.toThrow('Stale script');
    expect(() => behavior.beginTurn(1)).toThrow('increasing');
  });
});

const faqConfig = () =>
  AgentConfig.parse({
    name: 'Checked FAQ',
    mode: 'faq',
    allowedTools: ['balance'],
    tools: [
      {
        id: 'balance',
        description: 'Read balance',
        connector: 'native',
        effect: 'read',
        inputSchema: {
          type: 'object',
          properties: { account: { type: 'string' } },
          required: ['account'],
        },
        outputSchema: {
          type: 'object',
          properties: { balance: { type: 'number' } },
          required: ['balance'],
        },
      },
    ],
    faq: [
      {
        id: 'balance',
        question: 'my balance',
        requiresTool: 'balance',
        toolInput: { account: '{{account}}' },
        answer: 'Your balance is {{result.balance}}.',
      },
    ],
  });
const identity = { workspaceId: 'local', sessionId: 'call' };

describe('tool-dependent FAQ', () => {
  it('uses shared execution and renders only a successful checked result', async () => {
    const requests: unknown[] = [];
    const execution: Execution = {
      execute: async (request) => {
        requests.push(request);
        return {
          ...request,
          state: 'succeeded',
          result: { balance: 42 },
          createdAt: new Date().toISOString(),
        };
      },
    };
    const behavior = new ExecutingFaqBehavior(faqConfig(), execution, identity);
    expect(await behavior.respond('my balance', { account: 'a1' })).toBe('Your balance is 42.');
    expect(requests).toEqual([
      expect.objectContaining({ toolId: 'balance', input: { account: 'a1' }, confirmed: false }),
    ]);
  });

  it('rejects unapproved tools at construction and never turns unknown into success', async () => {
    const execution: Execution = {
      execute: async (request) => ({
        ...request,
        state: 'unknown',
        createdAt: new Date().toISOString(),
      }),
    };
    expect(
      () => new ExecutingFaqBehavior({ ...faqConfig(), allowedTools: [] }, execution, identity),
    ).toThrow('approved');
    const behavior = new ExecutingFaqBehavior(faqConfig(), execution, identity);
    expect(await behavior.respond('my balance', { account: 'a1' })).toBe(
      faqConfig().processing.failure,
    );
    expect(await behavior.respond('unrelated')).toBe(faqConfig().clarification);
  });

  it('cancels execution on a superseding turn and rejects late results', async () => {
    let resolve!: (record: OperationRecord) => void;
    let signal!: AbortSignal;
    const execution: Execution = {
      execute: (_request, options) => {
        signal = options!.signal!;
        return new Promise((r) => {
          resolve = r;
        });
      },
    };
    const behavior = new ExecutingFaqBehavior(faqConfig(), execution, identity);
    const old = behavior.respond('my balance', { account: 'a1' });
    await behavior.respond('unrelated');
    expect(signal.aborted).toBe(true);
    resolve({
      id: 'old',
      ...identity,
      toolId: 'balance',
      input: {},
      state: 'succeeded',
      result: { balance: 42 },
      createdAt: new Date().toISOString(),
    });
    await expect(old).rejects.toThrow('cancelled');
  });

  it('requires a heard confirmation for writes and reuses the fixed operation ID', async () => {
    const requests: Parameters<Execution['execute']>[0][] = [];
    const execution: Execution = {
      execute: async (request) => {
        requests.push(request);
        return {
          ...request,
          state: 'succeeded',
          result: { balance: 42 },
          createdAt: new Date().toISOString(),
        };
      },
    };
    const config = faqConfig();
    config.tools[0].effect = 'write';
    const behavior = new ExecutingFaqBehavior(config, execution, {
      ...identity,
      operationId: () => 'faq-write-1',
    });

    behavior.beginTurn(1);
    const prompt = await behavior.respond('my balance', { account: 'a1', confirmed: true });
    expect(prompt).toContain('Please confirm');
    expect(requests).toEqual([]);

    behavior.beginTurn(2);
    expect(await behavior.respond('yes')).toBe(prompt);
    expect(requests).toEqual([]);
    behavior.onPlayback(receipt(prompt, 2));

    behavior.beginTurn(3);
    expect(await behavior.respond('yes')).toBe('Your balance is 42.');
    expect(requests).toEqual([
      expect.objectContaining({ id: 'faq-write-1', confirmed: true, input: { account: 'a1' } }),
    ]);
  });

  it('keeps interrupted confirmation unapproved and blocks another write after unknown', async () => {
    const requests: Parameters<Execution['execute']>[0][] = [];
    const execution: Execution = {
      execute: async (request) => {
        requests.push(request);
        return { ...request, state: 'unknown', createdAt: new Date().toISOString() };
      },
    };
    const config = faqConfig();
    config.tools[0].effect = 'write';
    const behavior = new ExecutingFaqBehavior(config, execution, {
      ...identity,
      operationId: () => 'faq-write-unknown',
    });

    behavior.beginTurn(1);
    const prompt = await behavior.respond('my balance', { account: 'a1' });
    behavior.onPlayback(receipt(prompt, 1, 'interrupted'));
    behavior.beginTurn(2);
    expect(await behavior.respond('yes')).toBe(prompt);
    expect(requests).toEqual([]);
    behavior.onPlayback(receipt(prompt, 2));
    behavior.beginTurn(3);
    expect(await behavior.respond('yes')).toBe(config.processing.failure);
    expect(requests).toHaveLength(1);

    behavior.beginTurn(4);
    expect(await behavior.respond('my balance', { account: 'a1' })).toContain('reconcile');
    expect(requests).toHaveLength(1);
  });
});
