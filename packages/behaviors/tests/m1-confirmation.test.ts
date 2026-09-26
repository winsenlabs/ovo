import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type BehaviorEvent,
  type ExecutionRequest,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/agent.ts';

function fixture() {
  const effects: ExecutionRequest[] = [];
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Payment',
      mode: 'agent',
      locale: 'en-IN',
      allowedTools: ['pay'],
      tools: [
        {
          id: 'pay',
          connector: 'native',
          effect: 'write',
          confirmation: true,
          description: 'Pay the recipient',
          inputSchema: {
            type: 'object',
            properties: {
              amount: { type: 'number', title: 'Amount', 'x-unit': 'rupees' },
              recipient_name: { type: 'string', title: 'Recipient' },
              api_key: { type: 'string' },
            },
          },
        },
      ],
    }),
    {
      generate: async (request) =>
        request.results.length
          ? { kind: 'text', text: 'Paid.' }
          : {
              kind: 'tool',
              toolId: 'pay',
              input: { recipient_name: 'Ravi', api_key: 'do-not-speak', amount: 500 },
            },
    },
    {
      execute: async (request) => {
        effects.push(request);
        return { ...request, state: 'succeeded', createdAt: 'now' };
      },
    },
    { workspaceId: 'workspace', sessionId: 'session', operationId: () => 'operation' },
  );
  return { behavior, effects };
}

function receipt(text: string, evidence: SpeechReceipt['evidence'] = 'confirmed'): SpeechReceipt {
  return { id: 'receipt', text, epoch: 0, state: 'completed', evidence };
}

describe('M1 production agent confirmations', () => {
  it('speaks schema-ordered arguments with units, titles and redaction', async () => {
    const { behavior } = fixture();
    behavior.beginTurn(0);
    const prompt = await behavior.respond('pay Ravi');
    expect(prompt).toContain('Amount: 500 rupees, Recipient: Ravi');
    expect(prompt).toContain('[redacted]');
    expect(prompt).not.toMatch(/[{}]|do-not-speak/);
  });

  it.each(['haan', 'ji haan', 'haan ji', 'yes please', 'yes.', 'Yes!'])(
    'accepts %s only after heard playback',
    async (answer) => {
      const { behavior, effects } = fixture();
      behavior.beginTurn(0);
      const prompt = await behavior.respond('pay');
      behavior.onPlayback(receipt(prompt));
      behavior.beginTurn(1);
      expect(await behavior.respond(answer)).toBe('Paid.');
      expect(effects).toHaveLength(1);
    },
  );

  it.each(['no that is not correct', 'yes no cancel'])(
    'declines %s and makes no effect',
    async (answer) => {
      const { behavior, effects } = fixture();
      behavior.beginTurn(0);
      const prompt = await behavior.respond('pay');
      behavior.onPlayback(receipt(prompt));
      behavior.beginTurn(1);
      expect(await behavior.respond(answer)).toBe('Cancelled. No change was made.');
      expect(effects).toHaveLength(0);
    },
  );

  it('requires fresh non-estimated evidence after an unclear answer', async () => {
    const { behavior, effects } = fixture();
    behavior.beginTurn(0);
    const prompt = await behavior.respond('pay');
    behavior.onPlayback(receipt(prompt, 'estimated'));
    behavior.beginTurn(1);
    expect(await behavior.respond('yes')).toBe(prompt);
    expect(effects).toHaveLength(0);
    behavior.onPlayback({ ...receipt(prompt, 'simulated'), epoch: 1 });
    behavior.beginTurn(2);
    expect(await behavior.respond('okay')).toBe(prompt);
    expect(effects).toHaveLength(0);
  });

  it('publishes confirmation and execution hooks in order', async () => {
    const { behavior } = fixture();
    const events: BehaviorEvent[] = [];
    behavior.subscribe?.((event) => events.push(event));
    behavior.beginTurn(0);
    const prompt = await behavior.respond('pay');
    expect(behavior.speechKind?.(prompt)).toBe('confirmation');
    behavior.onPlayback(receipt(prompt));
    behavior.beginTurn(1);
    await behavior.respond('yes');
    expect(events.map((event) => event.type)).toEqual([
      'confirmation.pending',
      'confirmation.resolved',
      'tool.started',
      'tool.settled',
    ]);
    expect(events[1]).toMatchObject({ result: 'confirmed' });
  });
});
