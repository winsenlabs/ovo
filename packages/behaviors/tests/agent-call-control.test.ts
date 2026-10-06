import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionRequest,
  type Execution,
  type Inference,
  type InferenceReply,
  type InferenceRequest,
  type InferenceStreamEvent,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, AgentToolSelectionError, staticAgentLines } from '../src/index.ts';

// Tuesday 6 October 2026, 23:30 UTC: already Wednesday the 7th in Asia/Kolkata.
const NOW = new Date('2026-10-06T23:30:00Z');

const variables = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    amount_due: { type: 'number', 'x-ovo-format': 'currency', 'x-ovo-currency': 'INR' },
  },
  additionalProperties: false,
};
const call = { name: 'Ravi', amount_due: 12500 };

const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };

function llm(replies: (InferenceReply | InferenceStreamEvent[])[] = []) {
  const requests: InferenceRequest[] = [];
  const next = () => replies.shift() ?? { kind: 'text' as const, text: 'A composed LLM answer.' };
  const port: Inference = {
    generate: async (request) => {
      requests.push(request);
      return next() as InferenceReply;
    },
    async *stream(request) {
      requests.push(request);
      const reply = next();
      if (Array.isArray(reply)) yield* reply;
      else if (reply.kind === 'text') yield { kind: 'text-delta', delta: reply.text };
      else yield { kind: 'tool', toolId: reply.toolId, input: reply.input };
    },
  };
  return { port, requests };
}

function agent(
  over: Record<string, unknown> = {},
  options: { llm?: ReturnType<typeof llm>; decision?: DecisionPort } = {},
) {
  const model = options.llm ?? llm();
  const behavior = new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', variables, ...over }),
    model.port,
    execution,
    {
      workspaceId: 'w-1',
      sessionId: 's-1',
      now: () => NOW,
      ...(options.decision ? { decision: options.decision } : {}),
    },
  );
  return { behavior, model };
}

function receipt(text: string, epoch: number, state: SpeechReceipt['state'] = 'completed') {
  return { id: `${epoch}:${text}`, text, epoch, state, evidence: 'confirmed' as const };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const segment of stream) out.push(segment);
  return out;
}

const goodbye = (outcome: Record<string, unknown>) => ({
  enabled: true,
  questions: [
    {
      type: 'choice',
      id: 'intent',
      instructions: 'What does the caller want?',
      threshold: 0.8,
      fallback: 'clarify',
      options: [
        { key: 'bye', description: 'Wants to end the call', outcome },
        { key: 'other', description: 'Anything else', outcome: {} },
      ],
    },
  ],
  state: { sources: ['last-turn'] },
});

function decides(choice: string, confidence = 0.95, seen: DecisionRequest[] = []): DecisionPort {
  return {
    decide: async (request) => {
      seen.push(request);
      return {
        modelId: 'jev-1',
        answers: {
          intent: {
            type: 'choice',
            choice,
            confidence,
            calibrationVersion: 'jev-1/a',
            probabilities: { bye: confidence, other: 1 - confidence },
          } as DecisionAnswer,
        },
      };
    },
  };
}

describe('greet-first opening (AGT-2)', () => {
  it('speaks the rendered opening with no decision or LLM round trip', async () => {
    const { behavior, model } = agent({
      opening: { lines: ['Hello, this is Asha from Acme.', 'Am I speaking with {{name}}?'] },
    });
    expect(behavior.speaksFirst()).toBe(true);
    behavior.beginTurn(0);
    const lines = await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    expect(lines).toEqual(['Hello, this is Asha from Acme.', 'Am I speaking with Ravi?']);
    expect(model.requests).toHaveLength(0);
    // Spoken once: a second opening request (a retried start) says nothing.
    expect(await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }))).toEqual(
      [],
    );
  });

  it('remembers the played opening as the first thing the agent said', async () => {
    const { behavior, model } = agent({ opening: { lines: ['Am I speaking with {{name}}?'] } });
    behavior.beginTurn(0);
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    behavior.onPlayback(receipt('Am I speaking with Ravi?', 0));
    behavior.beginTurn(1);
    await behavior.respond('yes it is', call);
    expect(model.requests[0]!.history).toEqual([
      { role: 'assistant', content: 'Am I speaking with Ravi?' },
    ]);
  });

  it('does not speak first without an opening', () => {
    expect(agent().behavior.speaksFirst()).toBe(false);
  });

  it('fails the opening rather than read a missing variable aloud', async () => {
    const { behavior } = agent({ opening: { lines: ['Hello {{name}}.'] } });
    await expect(behavior.respond('', { inputEvent: 'opening' })).rejects.toThrow(
      'Missing announcement variable: name',
    );
  });

  it('refuses a line that names an undeclared variable before any call', () => {
    expect(() => agent({ opening: { lines: ['Hello {{nickname}}.'] } })).toThrow(
      'Template path is not declared by the variable schema: nickname',
    );
  });

  it('renders the date built-ins in the agent timezone', async () => {
    const { behavior } = agent({ opening: { lines: ['Today is {{today}}.'] } });
    expect(await behavior.respond('', { inputEvent: 'opening' })).toBe('Today is 7 October 2026.');
  });

  it('lists only placeholder-free lines as cacheable', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      variables,
      opening: { lines: ['Hello, this is Asha from Acme.', 'Am I speaking with {{name}}?'] },
      voicemail: { action: 'message', message: 'Please call Acme back.' },
    });
    expect(staticAgentLines(config).map((line) => [line.field, line.template])).toEqual([
      ['opening.lines.0', 'Hello, this is Asha from Acme.'],
      ['voicemail.message', 'Please call Acme back.'],
    ]);
  });
});

describe('per-call variables (AGT-5)', () => {
  it('gives the LLM the declared call facts, formatted, and nothing undeclared', async () => {
    const { behavior, model } = agent({ context: 'You collect payments for {{name}}.' });
    await behavior.respond('how much do I owe', { ...call, inputEvent: 'text', secret: 'x' });
    const context = model.requests[0]!.context;
    expect(context).toContain('You collect payments for Ravi.');
    expect(context).toContain('Call facts');
    expect(context).toContain('- name: Ravi');
    expect(context).toContain('- amount_due: ₹12,500.00');
    expect(context).toMatch(/- today: Wednesday,? 7 October 2026/);
    expect(context).not.toContain('secret');
    expect(context).not.toContain('inputEvent');
  });

  it('leaves a briefing placeholder it cannot fill for the LLM to read as written', async () => {
    const { behavior, model } = agent({ context: 'Ask for {{name}} about {{unknown_thing}}.' });
    await behavior.respond('hello', {});
    expect(model.requests[0]!.context).toContain('Ask for {{name}} about {{unknown_thing}}.');
  });

  it('renders a decision line with the call variables', async () => {
    const { behavior } = agent(
      { decision: goodbye({ say: 'Thank you {{name}}, goodbye.' }) },
      { decision: decides('bye') },
    );
    expect(await behavior.respond('bye', call)).toBe('Thank you Ravi, goodbye.');
  });

  it('lets the LLM answer when a decision line needs a variable this call lacks', async () => {
    const { behavior, model } = agent(
      { decision: goodbye({ say: 'Thank you {{name}}, goodbye.', end: true }) },
      { decision: decides('bye') },
    );
    behavior.beginTurn(1);
    expect(await behavior.respond('bye', { amount_due: 10 })).toBe('A composed LLM answer.');
    expect(model.requests).toHaveLength(1);
    behavior.onPlayback(receipt('A composed LLM answer.', 1));
    // The trusted decision still ends the call after the LLM's goodbye.
    expect(behavior.completionReason()).toBe('decision:intent=bye');
  });
});

describe('ending the call (AGT-3)', () => {
  it('completes only once the goodbye has played, with the decision as the reason', async () => {
    const { behavior, model } = agent(
      { decision: goodbye({ say: 'Thank you, goodbye.', end: true }) },
      { decision: decides('bye') },
    );
    behavior.beginTurn(3);
    expect(await behavior.respond('that is all, bye', call)).toBe('Thank you, goodbye.');
    expect(model.requests).toHaveLength(0);
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt('Thank you, goodbye.', 3));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:intent=bye');
  });

  it('keeps the call open when the caller barges in on the goodbye', async () => {
    const { behavior } = agent(
      { decision: goodbye({ say: 'Thank you, goodbye.', end: true }) },
      { decision: decides('bye') },
    );
    behavior.beginTurn(1);
    await behavior.respond('bye', call);
    behavior.onPlayback(receipt('Thank you, goodbye.', 1, 'interrupted'));
    expect(behavior.isComplete()).toBe(false);
  });

  it('does not end on a goodbye the decision was unsure about', async () => {
    const { behavior } = agent(
      { decision: goodbye({ say: 'Thank you, goodbye.', end: true }) },
      { decision: decides('bye', 0.3) },
    );
    behavior.beginTurn(1);
    const said = await behavior.respond('bye?', call);
    behavior.onPlayback(receipt(said, 1));
    expect(behavior.isComplete()).toBe(false);
  });

  it('lets the LLM compose the goodbye when the ending outcome has no line', async () => {
    const { behavior, model } = agent(
      { decision: goodbye({ end: true }) },
      { decision: decides('bye'), llm: llm([{ kind: 'text', text: 'Take care, bye.' }]) },
    );
    behavior.beginTurn(2);
    expect(await behavior.respond('bye', call)).toBe('Take care, bye.');
    expect(model.requests).toHaveLength(1);
    behavior.onPlayback(receipt('Take care, bye.', 2));
    expect(behavior.completionReason()).toBe('decision:intent=bye');
  });

  it("speaks the LLM's end_call goodbye and ends after it plays", async () => {
    const model = llm([
      { kind: 'tool', toolId: 'end_call', input: { goodbye: 'Thanks, bye!', reason: 'done' } },
    ]);
    const { behavior } = agent({ ending: { llmTool: true } }, { llm: model });
    behavior.beginTurn(1);
    expect(await behavior.respond('nothing else', call)).toBe('Thanks, bye!');
    expect(model.requests[0]!.tools.map((tool) => tool.id)).toContain('end_call');
    behavior.onPlayback(receipt('Thanks, bye!', 1));
    expect(behavior.completionReason()).toBe('llm:end_call:done');
  });

  it('accepts end_call after a streamed goodbye and waits for every streamed line', async () => {
    const model = llm([
      [
        { kind: 'text-delta', delta: 'Thank you for your time. Goodbye.' },
        { kind: 'tool', toolId: 'end_call', input: { goodbye: 'unused' } },
        { kind: 'finish' },
      ],
    ]);
    const { behavior } = agent({ ending: { llmTool: true } }, { llm: model });
    behavior.beginTurn(4);
    const lines = await collect(behavior.respondStream('no, that is all', call));
    expect(lines).toEqual(['Thank you for your time.', 'Goodbye.']);
    behavior.onPlayback(receipt('Thank you for your time.', 4));
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt('Goodbye.', 4));
    expect(behavior.completionReason()).toBe('llm:end_call');
  });

  it('never offers end_call unless the agent allows it', async () => {
    const model = llm([{ kind: 'tool', toolId: 'end_call', input: { goodbye: 'Bye.' } }]);
    const { behavior } = agent({}, { llm: model });
    await expect(behavior.respond('bye', call)).rejects.toBeInstanceOf(AgentToolSelectionError);
    expect(model.requests[0]!.tools).toEqual([]);
  });
});

describe('voicemail', () => {
  it('leaves the rendered message when the policy says so', () => {
    const { behavior } = agent({
      voicemail: { action: 'message', message: 'Hi {{name}}, please call Acme back.' },
    });
    expect(behavior.voicemail(call)).toBe('Hi Ravi, please call Acme back.');
  });

  it('hangs up without a message by default', () => {
    expect(agent({ opening: { lines: ['Hello.'] } }).behavior.voicemail(call)).toBe('');
  });

  it('leaves the call alone without a detecting policy', () => {
    expect(agent({}).behavior.voicemail(call)).toBeUndefined();
    const off = agent({ opening: { lines: ['Hello.'] }, voicemail: { detect: false } });
    expect(off.behavior.voicemail(call)).toBeUndefined();
  });
});

describe('decision state (AGT-13)', () => {
  it('shows the decision what the agent last said and today, without playback notes', async () => {
    const seen: DecisionRequest[] = [];
    const { behavior } = agent(
      {
        decision: {
          ...goodbye({}),
          state: { sources: ['agent-last-said', 'today', 'transcript', 'last-turn'] },
        },
      },
      { decision: decides('other', 0.95, seen) },
    );
    behavior.beginTurn(0);
    const first = await behavior.respond('hello', call);
    // Weak evidence is noted for the LLM, never shown to the decision model as speech.
    behavior.onPlayback({ ...receipt(first, 0), evidence: 'estimated' });
    behavior.beginTurn(1);
    await behavior.respond('I can pay on Friday', call);
    expect(seen[1]!.state).toEqual({
      agentLastSaid: 'A composed LLM answer.',
      today: expect.stringMatching(/^Wednesday,? 7 October 2026$/),
      transcript: [
        { speaker: 'caller', said: 'hello' },
        { speaker: 'agent', said: 'A composed LLM answer.' },
      ],
      lastCallerTurn: 'I can pay on Friday',
    });
  });
});
