import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@winsendotai/ovo-contracts';
import {
  agent,
  call,
  collect,
  decides,
  goodbye,
  llm,
  receipt,
} from './agent-call-control-fixture.ts';

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

  it('ends even when the speaker reports the goodbye as filtered text', async () => {
    const { behavior } = agent(
      { decision: goodbye({ say: 'Your ₹12,500 is noted, goodbye.', end: true }) },
      { decision: decides('bye') },
    );
    behavior.beginTurn(2);
    await behavior.respond('bye', call);
    // A verbalisation filter ran between the behaviour and the receipt.
    behavior.onPlayback(receipt('Your twelve thousand five hundred rupees is noted, goodbye.', 2));
    expect(behavior.completionReason()).toBe('decision:intent=bye');
  });

  it('ignores a receipt from an earlier turn', async () => {
    const { behavior } = agent(
      { decision: goodbye({ say: 'Thank you, goodbye.', end: true }) },
      { decision: decides('bye') },
    );
    behavior.beginTurn(5);
    await behavior.respond('bye', call);
    behavior.onPlayback(receipt('Thank you, goodbye.', 4));
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt('Thank you, goodbye.', 5));
    expect(behavior.isComplete()).toBe(true);
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
    // A model that calls it anyway is answered, not hung up on, and the call stays open (P8).
    expect(await behavior.respond('bye', call)).toBe(behavior.config.uncertainty);
    expect(behavior.toolErrors).toMatchObject([{ toolId: 'end_call' }]);
    expect(behavior.isComplete()).toBe(false);
    expect(model.requests[0]!.tools).toEqual([]);
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
