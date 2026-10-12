import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentConfig, type Inference } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { execution, sleep } from './speculation-fixture.ts';

/**
 * Wave 9, issue D6: Maya call 10d5ef30 (2026-10-12). Turn 22's reply was ready 1.68 s after the
 * turn ended, so its 1.5 s filler ("One moment.") played for 180 ms and was cut. The behaviour says
 * when the model's first words of a reply have arrived (`drafting`), so the engine can leave a
 * filler due then unsaid: the first line is a few hundred ms away.
 */
const FIRST_WORDS_MS = 1_300;
const SENTENCE_MS = 400;

/** The LLM's first words after `FIRST_WORDS_MS`, the rest of its sentence `SENTENCE_MS` later. */
const llm: Inference = {
  generate: () => Promise.reject(new Error('streamed only')),
  async *stream(request) {
    await sleep(FIRST_WORDS_MS, request.signal);
    yield { kind: 'text-delta', delta: 'Prague' };
    await sleep(SENTENCE_MS, request.signal);
    yield { kind: 'text-delta', delta: ' has lovely markets in December, and so does Vienna.' };
    yield { kind: 'finish' };
  },
};

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('call 10d5ef30 D6: the reply says when its first words are in', () => {
  it('is drafting from the first words until the next turn begins', async () => {
    const agent = new AgentBehavior(
      AgentConfig.parse({ name: 'Maya', mode: 'agent', reply: { firstPhraseWords: 0 } }),
      llm,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    agent.beginTurn(1);
    const first = agent
      .respondStream('Where are the Christmas markets?', {})
      [Symbol.asyncIterator]()
      .next();
    await vi.advanceTimersByTimeAsync(FIRST_WORDS_MS - 1);
    expect(agent.drafting()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // 1.3 s in: no line yet, but one is coming. A 1.5 s filler would be cut 0.2 s after it starts.
    expect(agent.drafting()).toBe(true);
    await vi.advanceTimersByTimeAsync(SENTENCE_MS);
    expect((await first).value).toMatch(/^Prague has lovely markets/);
    agent.beginTurn(2);
    expect(agent.drafting()).toBe(false);
  });
});
