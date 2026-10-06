import { describe, expect, it, vi } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import {
  call,
  collect,
  execution,
  llm,
  NOW,
  receipt,
  variables,
} from './agent-call-control-fixture.ts';

function agent(compliance: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const model = llm();
  const append = vi.fn(async () => undefined);
  const behavior = new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', variables, compliance, ...over }),
    model.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', now: () => NOW, events: { append } },
  );
  return { behavior, model, append };
}

describe('recording disclosure', () => {
  it('is spoken first, before the opening, as protected disclosure speech', async () => {
    const { behavior, model } = agent(
      { disclosure: { text: 'This call is recorded for quality purposes.' } },
      { opening: { lines: ['Am I speaking with {{name}}?'] } },
    );
    expect(behavior.speaksFirst()).toBe(true);
    const lines = await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    expect(lines).toEqual([
      'This call is recorded for quality purposes.',
      'Am I speaking with Ravi?',
    ]);
    expect(behavior.speechKind('This call is recorded for quality purposes.')).toBe('disclosure');
    expect(behavior.speechKind('Am I speaking with Ravi?')).toBeUndefined();
    expect(model.requests).toHaveLength(0);
  });

  it('makes an agent without an opening speak first', async () => {
    const { behavior } = agent({ disclosure: { text: 'This call is recorded.' } });
    expect(behavior.speaksFirst()).toBe(true);
    expect(await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }))).toEqual([
      'This call is recorded.',
    ]);
  });
});

describe('caller opt-out', () => {
  it('says the closing line, ends the call and records opted_out, without the LLM', async () => {
    const { behavior, model, append } = agent({
      optOut: { closingLine: 'Understood, goodbye.' },
    });
    behavior.beginTurn(1);
    const lines = await collect(behavior.respondStream('please stop calling me', call));
    expect(lines).toEqual(['Understood, goodbye.']);
    expect(model.requests).toHaveLength(0);
    expect(behavior.optedOut).toBe(true);
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt('Understood, goodbye.', 1));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('opt_out');
    expect(append).toHaveBeenCalledWith('disposition', {
      disposition: 'opted_out',
      turn: 1,
      source: 'rule',
      reason: 'caller_opt_out',
    });
  });

  it('answers ordinary turns as before, and never opts out an agent without the policy', async () => {
    const withPolicy = agent({ optOut: {} });
    expect(await withPolicy.behavior.respond('I will pay on Friday', call)).toBe(
      'A composed LLM answer.',
    );
    expect(withPolicy.behavior.optedOut).toBe(false);
    const without = agent({});
    expect(await without.behavior.respond('stop calling me', call)).toBe('A composed LLM answer.');
    expect(without.behavior.optedOut).toBe(false);
  });

  it('refuses the spoken blocks outside agent mode', () => {
    expect(() =>
      AgentConfig.parse({
        name: 'FAQ',
        mode: 'faq',
        compliance: { disclosure: { text: 'Recorded.' } },
      }),
    ).toThrow('agent mode');
    expect(
      AgentConfig.parse({
        name: 'FAQ',
        mode: 'faq',
        compliance: { callingHours: { start: '08:00', end: '19:00' } },
      }).compliance,
    ).toEqual({ callingHours: { start: '08:00', end: '19:00' } });
  });
});
