import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { staticAgentLines } from '../src/index.ts';
import {
  agent,
  call,
  collect,
  decides,
  goodbye,
  receipt,
  variables,
} from './agent-call-control-fixture.ts';

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

  it('skips an opening line whose variable the call lacks and keeps the call going', async () => {
    const { behavior, model } = agent({
      opening: { lines: ['Hello, this is Asha from Acme.', 'Am I speaking with {{name}}?'] },
    });
    const lines = await collect(behavior.respondStream('', { inputEvent: 'opening' }));
    expect(lines).toEqual(['Hello, this is Asha from Acme.']);
    expect(behavior.isComplete()).toBe(false);
    expect(behavior.skippedLines.map(({ turn, field }) => ({ turn, field }))).toEqual([
      { turn: 0, field: 'opening.lines.1' },
    ]);
    // The caller's reply is answered as usual, by the LLM.
    expect(await behavior.respond('who is this', call)).toBe('A composed LLM answer.');
    expect(model.requests).toHaveLength(1);
  });

  it('skips a line whose value does not fit its format, recording the field but not the value', async () => {
    const { behavior } = agent({
      variables: {
        type: 'object',
        properties: {
          due_date: { type: 'string', format: 'date' },
          amount_due: variables.properties.amount_due,
        },
      },
      opening: { lines: ['Your payment was due on {{due_date}}.', 'You owe {{amount_due}}.'] },
    });
    // CSV rows carry every value as a string.
    const row = { due_date: '06/10/2026', amount_due: '12500' };
    expect(await collect(behavior.respondStream('', { ...row, inputEvent: 'opening' }))).toEqual(
      [],
    );
    expect(behavior.isComplete()).toBe(false);
    expect(behavior.skippedLines.map((record) => record.field)).toEqual([
      'opening.lines.0',
      'opening.lines.1',
    ]);
    expect(JSON.stringify(behavior.skippedLines)).not.toMatch(/06\/10\/2026|12500/);
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
