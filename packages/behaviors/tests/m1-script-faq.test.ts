import { expect, it } from 'vitest';
import { AgentConfig, type BehaviorEvent } from '@winsendotai/ovo-contracts';
import { ExecutingFaqBehavior, FaqBehavior, ScriptBehavior } from '../src/index.ts';

const script = {
  start: 'start',
  nodes: [
    {
      id: 'start',
      prompt: 'Say continue.',
      transitions: [{ event: 'text', matches: ['continue'], to: 'done' }],
    },
    { id: 'done', prompt: 'Done.', terminal: true },
  ],
};
const played = (text: string, epoch: number) => ({
  id: 'receipt',
  text,
  epoch,
  state: 'completed' as const,
  evidence: 'confirmed' as const,
});

it('normalizes script transition punctuation', async () => {
  const behavior = new ScriptBehavior(AgentConfig.parse({ name: 'Script', mode: 'faq', script }));
  behavior.beginTurn(0);
  const prompt = await behavior.respond('');
  behavior.onPlayback(played(prompt, 0));
  behavior.beginTurn(1);
  expect(await behavior.respond('Continue!')).toBe('Done.');
});

it('keeps Devanagari marks distinct in FAQ matching', async () => {
  const behavior = new FaqBehavior(
    AgentConfig.parse({
      name: 'Hindi',
      mode: 'faq',
      locale: 'hi-IN',
      faq: [
        { id: 'art', question: 'कला', answer: 'Art.' },
        { id: 'tomorrow', question: 'कल', answer: 'Tomorrow.' },
      ],
    }),
  );
  expect(await behavior.respond('कला?')).toBe('Art.');
});

it('confirms a FAQ write through the script production hooks', async () => {
  const config = AgentConfig.parse({
    name: 'Script write',
    mode: 'faq',
    script,
    allowedTools: ['pay'],
    tools: [
      {
        id: 'pay',
        description: 'Pay',
        connector: 'native',
        effect: 'write',
        confirmation: true,
        inputSchema: { type: 'object' },
      },
    ],
    faq: [
      { id: 'pay', question: 'send payment', requiresTool: 'pay', toolInput: {}, answer: 'Paid.' },
    ],
  });
  let executions = 0;
  const inner = new ExecutingFaqBehavior(
    config,
    {
      execute: async (request) => {
        executions++;
        return { ...request, state: 'succeeded', result: {}, createdAt: 'now' };
      },
    },
    { workspaceId: 'workspace', sessionId: 'session' },
  );
  const behavior = new ScriptBehavior(config, inner);
  const events: BehaviorEvent[] = [];
  behavior.subscribe?.((event) => events.push(event));
  behavior.beginTurn(0);
  behavior.onPlayback(played(await behavior.respond(''), 0));
  behavior.beginTurn(1);
  const prompt = await behavior.respond('send payment');
  expect(behavior.speechKind?.(prompt)).toBe('confirmation');
  expect(prompt).not.toContain('Say continue.');
  behavior.onPlayback(played(prompt, 1));
  behavior.beginTurn(2);
  expect(await behavior.respond('yes please')).toBe('Paid. Say continue.');
  expect(executions).toBe(1);
  expect(events.map((event) => event.type)).toEqual([
    'confirmation.pending',
    'confirmation.resolved',
    'tool.started',
    'tool.settled',
  ]);
});

it('orders tied FAQ evidence by code units in every locale', () => {
  const behavior = new FaqBehavior(
    AgentConfig.parse({
      name: 'Ties',
      mode: 'faq',
      faq: ['a', 'A', 'é', 'z'].map((id) => ({ id, question: 'same question', answer: id })),
    }),
  );
  expect(behavior.match('same question').evidence.map((item) => item.id)).toEqual([
    'A',
    'a',
    'z',
    'é',
  ]);
});
