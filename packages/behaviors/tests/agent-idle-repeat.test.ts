import { describe, expect, it } from 'vitest';
import { DEFAULT_DIDNT_CATCH } from '@winsendotai/ovo-contracts';
import { agent, call, collect, receipt } from './agent-call-control-fixture.ts';
import { jev, jevOnly, policy } from './jev-only-fixture.ts';

const idle = {
  prompts: ['Hello? Can you hear me?', 'Are you there, {{name}}?'],
  finalLine: 'I will call back later. Goodbye.',
};
const silence = { ...call, inputEvent: 'idle' };

describe('per-agent idle lines (AGT-11)', () => {
  it('escalates through the prompts, then speaks the final line and ends the call', async () => {
    const { behavior, model } = agent({ idle });
    expect(behavior.idleTimeoutMs()).toBe(8000);
    behavior.beginTurn(1);
    expect(await collect(behavior.respondStream('', silence))).toEqual(['Hello? Can you hear me?']);
    expect(behavior.speechKind('Hello? Can you hear me?')).toBe('idle-prompt');
    behavior.onPlayback(receipt('Hello? Can you hear me?', 1));
    behavior.beginTurn(2);
    expect(await collect(behavior.respondStream('', silence))).toEqual(['Are you there, Ravi?']);
    behavior.onPlayback(receipt('Are you there, Ravi?', 2));
    expect(behavior.isComplete()).toBe(false);
    behavior.beginTurn(3);
    expect(await collect(behavior.respondStream('', silence))).toEqual([
      'I will call back later. Goodbye.',
    ]);
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt('I will call back later. Goodbye.', 3));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('idle:no-input');
    expect(model.requests).toHaveLength(0);
  });

  it('records idle prompts in history, so the LLM sees the agent asked', async () => {
    const { behavior, model } = agent({ idle });
    behavior.beginTurn(1);
    await collect(behavior.respondStream('', silence));
    behavior.onPlayback(receipt('Hello? Can you hear me?', 1));
    behavior.beginTurn(2);
    await behavior.respond('yes sorry, I am here', call);
    expect(model.requests[0]!.history).toEqual([
      { role: 'assistant', content: 'Hello? Can you hear me?' },
    ]);
    // The prompt is no longer an idle prompt once a caller turn starts.
    expect(behavior.speechKind('Hello? Can you hear me?')).toBeUndefined();
  });

  it('starts the escalation over when the caller speaks', async () => {
    const { behavior } = agent({ idle });
    await collect(behavior.respondStream('', silence));
    await behavior.respond('hello?', call);
    expect(await collect(behavior.respondStream('', silence))).toEqual(['Hello? Can you hear me?']);
  });

  it('a barge-in on the final line keeps the call open', async () => {
    const { behavior } = agent({ idle: { finalLine: 'Goodbye.' } });
    behavior.beginTurn(1);
    expect(await collect(behavior.respondStream('', silence))).toEqual(['Goodbye.']);
    behavior.onPlayback(receipt('Goodbye.', 1, 'interrupted'));
    expect(behavior.isComplete()).toBe(false);
  });

  it('ends at once after the last prompt when there is no final line', async () => {
    const { behavior } = agent({ idle: { prompts: ['Hello?'] } });
    behavior.beginTurn(1);
    await collect(behavior.respondStream('', silence));
    behavior.onPlayback(receipt('Hello?', 1));
    behavior.beginTurn(2);
    expect(await collect(behavior.respondStream('', silence))).toEqual([]);
    expect(behavior.isComplete()).toBe(true);
  });

  it('has no idle timeout without an idle policy, and ignores an idle turn', async () => {
    const { behavior, model } = agent();
    expect(behavior.idleTimeoutMs()).toBeUndefined();
    expect(await collect(behavior.respondStream('', silence))).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });
});

describe('repeat (AGT-12)', () => {
  const recovery = { repeat: { phrases: ['one more time'] } };

  it('replays the last turn after the prefix, with no decision call', async () => {
    const decision = jev(['pay', 0.95]);
    const behavior = jevOnly({ decision: policy(), recovery }, decision.port);
    expect(await behavior.respond('I will pay', call)).toBe('Thank you, Ravi.');
    expect(await behavior.respond('Sorry?', call)).toBe(
      'Sure, let me repeat that. Thank you, Ravi.',
    );
    expect(await behavior.respond('one more time', call)).toBe(
      'Sure, let me repeat that. Thank you, Ravi.',
    );
    expect(decision.seen).toHaveLength(1);
  });

  it('replays the opening, and never a recovery line', async () => {
    const behavior = jevOnly(
      {
        decision: policy(),
        recovery,
        opening: { lines: ['Hi, this is Asha.', 'Is this {{name}}?'] },
      },
      jev().port,
    );
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    expect(await behavior.respond('   ', call)).toBe(DEFAULT_DIDNT_CATCH);
    expect(await behavior.respond('kya?', call)).toBe(
      'Sure, let me repeat that. Hi, this is Asha. Is this Ravi?',
    );
  });

  it('is an ordinary reply without a repeat policy, or before anything was said', async () => {
    const decision = jev(['other', 0.9], ['other', 0.9]);
    expect(await jevOnly({ decision: policy() }, decision.port).respond('sorry?', call)).toBe(
      'Let me note that.',
    );
    expect(
      await jevOnly({ decision: policy(), recovery }, decision.port).respond('sorry?', call),
    ).toBe('Let me note that.');
  });
});
