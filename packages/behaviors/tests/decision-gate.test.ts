import { describe, expect, it } from 'vitest';
import {
  AgentDecisionPolicy,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResponse,
} from '@winsendotai/ovo-contracts';
import { DecisionGate, action, type DecisionTurn } from '../src/decision-gate.ts';

const question = {
  type: 'choice' as const,
  id: 'intent',
  instructions: 'What does the caller want?',
  threshold: 0.8,
  fallback: 'llm' as const,
  options: [
    { key: 'pay', description: 'Wants to pay', outcome: { say: 'Sending a link.' } },
    { key: 'later', description: 'Wants to pay later', outcome: {} },
  ],
};

const policy = (over: Record<string, unknown> = {}) =>
  AgentDecisionPolicy.parse({
    enabled: true,
    questions: [question],
    state: { sources: ['last-turn'] },
    ...over,
  });

const turn: DecisionTurn = {
  input: 'I will pay now',
  history: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'I will pay now' },
  ],
  variables: { accountId: 'A-1' },
  context: 'Outstanding is 4,210 rupees.',
};

const reply = (over: Partial<DecisionAnswer> = {}): DecisionResponse => ({
  modelId: 'jev-1',
  answers: {
    intent: {
      type: 'choice',
      choice: 'pay',
      confidence: 0.93,
      calibrationVersion: 'jev-1/cohort-a',
      probabilities: { pay: 0.9, later: 0.1 },
      ...over,
    } as DecisionAnswer,
  },
});

const port = (decide: DecisionPort['decide']): DecisionPort => ({ decide });
const live = () => new AbortController().signal;

describe('decision gate', () => {
  it('does nothing at all when the policy is disabled', async () => {
    let called = false;
    const gate = new DecisionGate(
      policy({ enabled: false }),
      port(async () => {
        called = true;
        return reply();
      }),
    );
    expect(await gate.evaluate(turn, live())).toEqual({ kind: 'off' });
    expect(called).toBe(false);
  });

  it('reports a trusted answer with the authored outcome', async () => {
    const gate = new DecisionGate(
      policy(),
      port(async () => reply()),
    );
    const result = await gate.evaluate(turn, live());
    expect(result).toMatchObject({
      kind: 'decided',
      modelId: 'jev-1',
      action: { say: 'Sending a link.', deferToLlm: false, clarify: false },
    });
  });

  it('defers to the LLM below the authored threshold', async () => {
    const gate = new DecisionGate(
      policy(),
      port(async () => reply({ confidence: 0.5 })),
    );
    const result = await gate.evaluate(turn, live());
    expect(result).toMatchObject({ kind: 'decided', action: { deferToLlm: true, clarify: false } });
    expect((result as { action: { say?: string } }).action.say).toBeUndefined();
  });

  it('asks for clarification below threshold when that is what was authored', async () => {
    const gate = new DecisionGate(
      policy({ questions: [{ ...question, fallback: 'clarify' }] }),
      port(async () => reply({ confidence: 0.5 })),
    );
    expect(await gate.evaluate(turn, live())).toMatchObject({
      action: { clarify: true, deferToLlm: false },
    });
  });

  it('sends only the authored state sources', async () => {
    const seen: DecisionRequest[] = [];
    const capture = port(async (request) => {
      seen.push(request);
      return reply();
    });
    await new DecisionGate(policy(), capture).evaluate(turn, live());
    expect(seen[0]!.state).toEqual({ lastCallerTurn: 'I will pay now' });

    await new DecisionGate(
      policy({ state: { sources: ['transcript', 'variables', 'context'], transcriptTurns: 2 } }),
      capture,
    ).evaluate(turn, live());
    expect(seen[1]!.state).toEqual({
      transcript: [
        { speaker: 'agent', said: 'hi there' },
        { speaker: 'caller', said: 'I will pay now' },
      ],
      variables: { accountId: 'A-1' },
      briefing: 'Outstanding is 4,210 rupees.',
    });
    // A source the operator did not list must not reach the model, however available it is.
    expect(JSON.stringify(seen[1]!.state)).not.toContain('lastCallerTurn');
  });

  it('keeps the state shape stable when a listed source happens to be empty', async () => {
    const seen: DecisionRequest[] = [];
    await new DecisionGate(
      policy({ state: { sources: ['context'] } }),
      port(async (request) => {
        seen.push(request);
        return reply();
      }),
    ).evaluate({ ...turn, context: '' }, live());
    expect(seen[0]!.state).toEqual({ briefing: '' });
  });

  it('falls through on timeout rather than holding the turn open', async () => {
    const gate = new DecisionGate(
      policy({ timeoutMs: 50 }),
      port(
        (_request, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason)),
          ),
      ),
    );
    const result = await gate.evaluate(turn, live());
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'timeout' });
    expect((result as { message: string }).message).toContain('50ms');
  });

  it('falls through when the decision model fails', async () => {
    const gate = new DecisionGate(
      policy(),
      port(async () => {
        throw new Error('502 from the model');
      }),
    );
    expect(await gate.evaluate(turn, live())).toEqual({
      kind: 'unavailable',
      reason: 'error',
      message: '502 from the model',
    });
  });

  it('falls through when no decision plugin is available', async () => {
    expect(await new DecisionGate(policy(), undefined).evaluate(turn, live())).toMatchObject({
      kind: 'unavailable',
      reason: 'error',
    });
  });

  it('re-validates the exchange itself rather than trusting the plugin', async () => {
    // A conformant plugin would never return this. A third-party one is the point of the boundary.
    const gate = new DecisionGate(
      policy(),
      port(async () =>
        reply({ probabilities: { pay: 0.4, later: 0.5 } } as Partial<DecisionAnswer>),
      ),
    );
    const result = await gate.evaluate(turn, live());
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'invalid' });
    expect((result as { message: string }).message).toMatch(/normalized/);
  });

  it('rejects an answer to a question that was not asked', async () => {
    const gate = new DecisionGate(
      policy(),
      port(async () => ({ modelId: 'jev-1', answers: { invented: reply().answers.intent! } })),
    );
    expect(await gate.evaluate(turn, live())).toMatchObject({
      kind: 'unavailable',
      reason: 'invalid',
    });
  });

  it('rethrows a cancelled turn instead of reporting a decision failure', async () => {
    const controller = new AbortController();
    const gate = new DecisionGate(
      policy({ timeoutMs: 5_000 }),
      port(
        (_request, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason)),
          ),
      ),
    );
    const pending = gate.evaluate(turn, controller.signal);
    controller.abort(new DOMException('caller hung up', 'AbortError'));
    await expect(pending).rejects.toThrow(/caller hung up/);
  });

  it('cancels the model call when the turn is cancelled', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const gate = new DecisionGate(
      policy({ timeoutMs: 5_000 }),
      port(
        (_request, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => {
              cancelled = true;
              reject(options.signal.reason);
            }),
          ),
      ),
    );
    const pending = gate.evaluate(turn, controller.signal);
    controller.abort(new DOMException('superseded', 'AbortError'));
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});

describe('folding several answers into one turn', () => {
  const resolution = (over: Record<string, unknown>) =>
    ({ questionId: 'q', answer: reply().answers.intent!, ...over }) as never;

  it('speaks the first trusted outcome that has a line', () => {
    expect(
      action([
        resolution({ used: true, outcome: {} }),
        resolution({ used: true, outcome: { say: 'second' } }),
        resolution({ used: true, outcome: { say: 'third' } }),
      ]),
    ).toEqual({ say: 'second', deferToLlm: false, clarify: false });
  });

  it('stops deferring once something has been said', () => {
    expect(
      action([
        resolution({ used: true, outcome: { say: 'answer' } }),
        resolution({
          used: false,
          fallback: 'llm',
          reason: 'below-threshold',
          confidence: 0.1,
          threshold: 0.9,
        }),
      ]),
    ).toEqual({ say: 'answer', deferToLlm: false, clarify: false });
  });

  it('prefers the LLM over clarification when both were asked for', () => {
    expect(
      action([
        resolution({
          used: false,
          fallback: 'clarify',
          reason: 'below-threshold',
          confidence: 0.1,
          threshold: 0.9,
        }),
        resolution({
          used: false,
          fallback: 'llm',
          reason: 'below-threshold',
          confidence: 0.1,
          threshold: 0.9,
        }),
      ]),
    ).toEqual({ deferToLlm: true, clarify: false });
  });

  it('hands a trusted but silent outcome on without speaking or deferring', () => {
    expect(action([resolution({ used: true, outcome: {} })])).toEqual({
      deferToLlm: false,
      clarify: false,
    });
  });
});
