import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentConfig, type SpeechReceipt } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { speculatedUtterance } from '../src/speculation-llm.ts';
import { LLM_MS, execution, settleMs, slowLlm } from './speculation-fixture.ts';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Reads a reply to its end on the fake clock. */
async function drain(reply: AsyncIterable<string>): Promise<void> {
  const iterator = reply[Symbol.asyncIterator]();
  for (;;) {
    const next = iterator.next();
    await settleMs(next, advance);
    if ((await next).done) return;
  }
}

const played = (text: string, epoch: number): SpeechReceipt => ({
  id: crypto.randomUUID(),
  text,
  epoch,
  state: 'completed',
  evidence: 'confirmed',
});

/** Maya, greeted: no decision model, so every caller turn goes to the LLM. */
async function maya() {
  const llm = slowLlm();
  const agent = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      uncertainty: "I'm not completely sure about that. Want me to look it up?",
      opening: { lines: [GREETING] },
      languages: { allowed: ['en', 'hi'] },
    }),
    llm.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1' },
  );
  agent.beginTurn(1);
  await agent.respond('', { inputEvent: 'opening' });
  agent.onPlayback(played(GREETING, 1));
  return { agent, llm };
}

/**
 * Wave 10, B2 (call 4f1a919d): "Chennai, Chennai." (turn 7) and, 1 s later, "Madras." (turn 8). The
 * final "Madras." asked the LLM at once while turn 7's searching answer was being composed; that
 * call ran its own web search to the end and was thrown away 17.8 s later, when turn 8, queued
 * behind the answer, asked something else. Two searches for one caller moment.
 */
describe('no LLM call is asked ahead while a reply is being composed', () => {
  it('"Madras." heard while turn 7 is answered is not asked; turn 8 asks once, itself', async () => {
    const { agent, llm } = await maya();
    agent.finalize({ turnId: 'turn-7', text: 'Chennai, Chennai.', merged: false });
    agent.beginTurn(2);
    const answer = agent.respondStream('Chennai, Chennai.', {})[Symbol.asyncIterator]();
    const first = answer.next();
    await advance(100);
    expect(llm.requests).toHaveLength(1);
    agent.prepare({ turnId: 'turn-8', text: 'Madras.', stable: true });
    await advance(LLM_MS);
    expect(llm.requests).toHaveLength(1);
    expect((await first).value).toBe('A composed LLM answer.');
    expect((await answer.next()).done).toBe(true);
    // The answer has been composed but not heard: the history is still changing.
    agent.prepare({ turnId: 'turn-8', text: 'Madras.', stable: true });
    expect(llm.requests).toHaveLength(1);
    agent.onPlayback(played('A composed LLM answer.', 2));
    // Played: words are asked ahead again, and the turn takes that call.
    agent.prepare({ turnId: 'turn-8', text: 'Madras.', stable: true });
    expect(llm.requests).toHaveLength(2);
    agent.finalize({ turnId: 'turn-8', text: 'Madras.', merged: false });
    agent.beginTurn(3);
    await drain(agent.respondStream('Madras.', {}));
    expect(llm.requests).toHaveLength(2);
    expect(agent.speculationMetrics.llm).toMatchObject({ started: 1, used: 1, discarded: 0 });
  });

  it('a reply cut by the caller frees the words they barge in with at once', async () => {
    const { agent, llm } = await maya();
    agent.finalize({ turnId: 'turn-7', text: 'Chennai, Chennai.', merged: false });
    agent.beginTurn(2);
    const answer = agent.respondStream('Chennai, Chennai.', {})[Symbol.asyncIterator]();
    void answer.next().catch(() => undefined);
    await advance(100);
    agent.cancel('turn interrupted');
    agent.prepare({ turnId: 'turn-8', text: 'No, from Madras.', stable: true });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
  });

  it('a call asked ahead carries the utterance it was asked for, for telemetry', async () => {
    const { agent, llm } = await maya();
    agent.prepare({ turnId: 'turn-2', text: 'Madras.', stable: true });
    const request = llm.requests[0]!;
    expect(speculatedUtterance(request)).toBe('turn-2');
    expect(speculatedUtterance(request.signal)).toBe('turn-2');
    // The turn's own requests carry none.
    agent.finalize({ turnId: 'turn-3', text: 'Frankfurt.', merged: false });
    agent.beginTurn(2);
    await drain(agent.respondStream('Frankfurt.', {}));
    expect(speculatedUtterance(llm.requests[1]!)).toBeUndefined();
  });
});
