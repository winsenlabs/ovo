import { describe, expect, it } from 'vitest';
import { DEFAULT_DIDNT_CATCH, DEFAULT_GIVE_UP } from '@winsendotai/ovo-contracts';
import { call, collect, llm, receipt } from './agent-call-control-fixture.ts';
import { jev, jevOnly, policy } from './jev-only-fixture.ts';

describe('Jev-only agents: no LLM bound (AGT-4)', () => {
  it('answers from the decision policy and never needs an LLM', async () => {
    const decision = jev(['pay', 0.95]);
    const behavior = jevOnly({ decision: policy() }, decision.port);
    expect(await behavior.respond('I will pay tomorrow', call)).toBe('Thank you, Ravi.');
    expect(decision.seen).toHaveLength(1);
  });

  it('speaks the didnt-catch line where the turn would have gone to the LLM', async () => {
    // Below threshold with an `llm` fallback: the configured path reaches the absent LLM.
    const behavior = jevOnly({ decision: policy('llm') }, jev(['pay', 0.4]).port);
    expect(await behavior.respond('hmm well', call)).toBe(DEFAULT_DIDNT_CATCH);
  });

  it('speaks the built-in line when the decision is unavailable and nothing is configured', async () => {
    const behavior = jevOnly({ decision: policy() }, jev(new Error('jev down')).port);
    expect(await behavior.respond('I will pay', call)).toBe(DEFAULT_DIDNT_CATCH);
    expect(behavior.decisions.at(-1)?.result).toMatchObject({
      kind: 'unavailable',
      reason: 'error',
    });
  });
});

describe('decision unavailable (AGT-4)', () => {
  it('keeps the LLM fallback for an agent configured before Wave 3', async () => {
    const model = llm();
    const behavior = jevOnly({ decision: policy() }, jev(new Error('jev down')).port, model);
    expect(await behavior.respond('I will pay', call)).toBe('A composed LLM answer.');
    expect(model.requests).toHaveLength(1);
  });

  it('speaks the configured line instead of the LLM, on an error or a timeout', async () => {
    const model = llm();
    // A decision that never answers, but honours the deadline's abort as a real port does.
    const hang = {
      decide: (_: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    };
    const timed = jevOnly(
      {
        decision: { ...policy(), timeoutMs: 50 },
        decisionUnavailable: { line: 'One moment, {{name}}.' },
      },
      hang,
      model,
    );
    expect(await timed.respond('I will pay', call)).toBe('One moment, Ravi.');
    expect(timed.decisions.at(-1)?.result).toMatchObject({
      kind: 'unavailable',
      reason: 'timeout',
    });
    const failed = jevOnly(
      { decision: policy(), decisionUnavailable: { line: 'One moment, {{name}}.' } },
      jev(new Error('jev down')).port,
      model,
    );
    expect(await failed.respond('I will pay', call)).toBe('One moment, Ravi.');
    expect(model.requests).toHaveLength(0);
  });

  it('ends the call once the line has played when the action is end', async () => {
    const behavior = jevOnly(
      {
        decision: policy(),
        decisionUnavailable: { line: 'We will call you back.', action: 'end' },
      },
      jev(new Error('jev down')).port,
    );
    behavior.beginTurn(1);
    expect(await collect(behavior.respondStream('I will pay', call))).toEqual([
      'We will call you back.',
    ]);
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt('We will call you back.', 1));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:unavailable');
  });
});

describe('bounded recovery (AGT-12)', () => {
  const recovery = { reprompts: { intent: 'When can you make the payment, {{name}}?' } };

  it("re-asks the question that wanted clarification, else says the didn't-catch line", async () => {
    const behavior = jevOnly({ decision: policy(), recovery }, jev(['pay', 0.4]).port);
    expect(await behavior.respond('umm', call)).toBe('When can you make the payment, Ravi?');
    const plain = jevOnly({ decision: policy(), recovery: {} }, jev(['pay', 0.4]).port);
    expect(await plain.respond('umm', call)).toBe(DEFAULT_DIDNT_CATCH);
  });

  it('keeps the old clarification line without a recovery block', async () => {
    const behavior = jevOnly({ decision: policy() }, jev(['pay', 0.4]).port, llm());
    expect(await behavior.respond('umm', call)).toBe('Please clarify your question.');
  });

  it('gives up after maxAttempts misses in a row, and ends on the give-up line', async () => {
    const behavior = jevOnly(
      { decision: policy(), recovery },
      jev(['pay', 0.4], ['pay', 0.4], ['pay', 0.4]).port,
    );
    expect(await behavior.respond('umm', call)).toBe('When can you make the payment, Ravi?');
    expect(await behavior.respond('err', call)).toBe('When can you make the payment, Ravi?');
    behavior.beginTurn(3);
    expect(await collect(behavior.respondStream('hmm', call))).toEqual([DEFAULT_GIVE_UP]);
    behavior.onPlayback(receipt(DEFAULT_GIVE_UP, 3));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('recovery:exhausted');
  });

  it('starts counting again once the caller is understood', async () => {
    const behavior = jevOnly(
      { decision: policy(), recovery: { ...recovery, maxAttempts: 1 } },
      jev(['pay', 0.4], ['pay', 0.95], ['pay', 0.4]).port,
    );
    expect(await behavior.respond('umm', call)).toBe('When can you make the payment, Ravi?');
    expect(await behavior.respond('I will pay', call)).toBe('Thank you, Ravi.');
    expect(await behavior.respond('umm', call)).toBe('When can you make the payment, Ravi?');
    expect(behavior.isComplete()).toBe(false);
  });

  it('hands the turn to the LLM when exhaustion says so', async () => {
    const model = llm();
    const behavior = jevOnly(
      { decision: policy(), recovery: { maxAttempts: 1, exhausted: { action: 'llm' } } },
      jev(['pay', 0.4], ['pay', 0.4]).port,
      model,
    );
    expect(await behavior.respond('umm', call)).toBe(DEFAULT_DIDNT_CATCH);
    expect(await behavior.respond('umm', call)).toBe('A composed LLM answer.');
    expect(model.requests).toHaveLength(1);
  });

  it('counts an unavailable decision as a miss', async () => {
    const behavior = jevOnly(
      { decision: policy(), recovery: { maxAttempts: 1 }, decisionUnavailable: { line: 'Sorry?' } },
      jev(new Error('down'), new Error('down')).port,
    );
    expect(await behavior.respond('I will pay', call)).toBe('Sorry?');
    expect(await behavior.respond('I will pay', call)).toBe(DEFAULT_GIVE_UP);
  });

  it('recovers an empty reply without asking the decision model', async () => {
    const decision = jev();
    const behavior = jevOnly({ decision: policy(), recovery: {} }, decision.port);
    expect(await behavior.respond('  ', call)).toBe(DEFAULT_DIDNT_CATCH);
    expect(decision.seen).toHaveLength(0);
  });
});
