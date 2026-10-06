import { describe, expect, it } from 'vitest';
import { AgentConfig, type Behavior, type DecisionPort } from '@winsendotai/ovo-contracts';
import { ScriptBehavior, scriptDecisionRequest, withScript } from '../src/index.ts';
import { scriptedJev, type Scripted } from './flow-fixture.ts';

const script = {
  start: 'ask',
  nodes: [
    {
      id: 'ask',
      prompt: 'Shall I send the payment link, {{name}}?',
      transitions: [
        { event: 'text', matches: ['yes', 'sure'], to: 'sent' },
        { event: 'text', matches: ['no'], to: 'bye' },
        { event: 'dtmf', matches: ['1'], to: 'sent' },
      ],
    },
    { id: 'sent', prompt: 'Sent.', terminal: true },
    { id: 'bye', prompt: 'Goodbye.', terminal: true },
  ],
};

const config = (decision: Record<string, unknown> | undefined, mode = 'announcement') =>
  AgentConfig.parse({
    name: 'Reminder',
    mode,
    script,
    variables: {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
    clarification: 'Please say yes or no.',
    ...(decision ? { decision } : {}),
  });

const played = (text: string, epoch: number) => ({
  id: `${epoch}`,
  text,
  epoch,
  state: 'completed' as const,
  evidence: 'confirmed' as const,
});

async function asked(
  behavior: Behavior,
  reply: string,
  variables: Record<string, unknown> = { name: 'Ravi' },
) {
  behavior.beginTurn!(0);
  const prompt = await behavior.respond('', variables);
  behavior.onPlayback!(played(prompt, 0));
  behavior.beginTurn!(1);
  return behavior.respond(reply, variables);
}

function scripted(answers: (Scripted | Error)[], decision = { enabled: true }, faq?: Behavior) {
  const jev = scriptedJev(answers);
  return { behavior: new ScriptBehavior(config(decision), faq, jev.port as DecisionPort), jev };
}

describe('decisions in scripts mode (AGT-14)', () => {
  it('still takes an exact transition with no decision call', async () => {
    const { behavior, jev } = scripted([]);
    expect(await asked(behavior, 'Sure!')).toBe('Sent.');
    expect(jev.requests).toHaveLength(0);
  });

  it("classifies an unmatched reply among the node's own transitions", async () => {
    const { behavior, jev } = scripted([{ intent: 'option_1' }]);
    expect(await asked(behavior, 'haan bhej do')).toBe('Sent.');
    expect(jev.requests[0]).toEqual({
      state: {
        caller_reply: 'haan bhej do',
        agent_last_said: 'Shall I send the payment link, Ravi?',
      },
      questions: {
        intent: {
          type: 'choice',
          instructions:
            'The agent said: "Shall I send the payment link, {{name}}?" Which option does `caller_reply` mean?',
          criteria: {
            option_1: 'The caller\'s reply means the same as "yes" or "sure"',
            option_2: 'The caller\'s reply means the same as "no"',
            other:
              'None of the above fits: a question, a new topic, or anything the listed options do not cover',
          },
        },
      },
    });
  });

  it('keeps the script where it is for other, a hesitant answer or a failed decision', async () => {
    for (const answer of [
      { intent: 'other' },
      { intent: 'option_2', confidence: 0.5 },
      new Error('jev down'),
    ]) {
      const { behavior } = scripted([answer]);
      expect(await asked(behavior, 'what link?')).toBe('Please say yes or no.');
    }
  });

  it('falls through to the FAQ detour when the decision cannot place the reply', async () => {
    const faq: Behavior = { respond: async () => 'We are open nine to five.' };
    const { behavior } = scripted([{ intent: 'other' }], { enabled: true }, faq);
    expect(await asked(behavior, 'when are you open')).toBe(
      'We are open nine to five. Shall I send the payment link, Ravi?',
    );
  });

  it('never sends a keypress to the decision model', async () => {
    const { behavior, jev } = scripted([]);
    behavior.beginTurn(0);
    await behavior.respond('', { name: 'Ravi' });
    behavior.onPlayback(played('Shall I send the payment link, Ravi?', 0));
    behavior.beginTurn(1);
    expect(await behavior.respond('9', { name: 'Ravi', inputEvent: 'dtmf' })).toBe(
      'Please say yes or no.',
    );
    expect(jev.requests).toHaveLength(0);
  });

  it('asks nothing when the policy is disabled or no plugin is selected', async () => {
    const disabled = scripted([], { enabled: false });
    expect(await asked(disabled.behavior, 'haan')).toBe('Please say yes or no.');
    expect(disabled.jev.requests).toHaveLength(0);
    const unplugged = withScript(config({ enabled: true }), { respond: async () => '' });
    expect(await asked(unplugged, 'haan')).toBe('Please say yes or no.');
  });

  it('abandons the decision when the turn is cancelled', async () => {
    let aborted = false;
    const port: DecisionPort = {
      decide: (_request, options) =>
        new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(options.signal.reason);
          }),
        ),
    };
    const behavior = new ScriptBehavior(config({ enabled: true }), undefined, port);
    behavior.beginTurn(0);
    await behavior.respond('', { name: 'Ravi' });
    behavior.onPlayback(played('Shall I send the payment link, Ravi?', 0));
    behavior.beginTurn(1);
    const pending = behavior.respond('hmm', { name: 'Ravi' });
    behavior.cancel();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(aborted).toBe(true);
  });

  it('offers no choice at a node without text transitions', () => {
    expect(
      scriptDecisionRequest(
        { id: 'x', prompt: 'Press one.', terminal: false, transitions: [] },
        {},
      ),
    ).toBeUndefined();
  });
});
