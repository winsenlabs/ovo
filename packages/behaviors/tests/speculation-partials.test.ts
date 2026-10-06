import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentConfig, type DecisionResponse } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { peekHistory } from '../src/speculation-history.ts';
import { PlaybackConversation } from '../src/history.ts';
import {
  JEV_MS,
  atPayment,
  call,
  execution,
  firstSegment,
  flowAgent,
  settleMs,
  slowJev,
} from './speculation-fixture.ts';

const TOMORROW = "Thank you. I've noted that you'll pay tomorrow.";
const promise = { 'kal kar dunga': { intent: 'promise_to_pay', slots: { ptp_when: 'tomorrow' } } };

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a decision on the caller’s partial transcript (LAT-4)', () => {
  it('answers a confident turn with no decision wait once the partial matched', async () => {
    // Baseline: the decision model's round trip sits between end of speech and first audio.
    const plainJev = slowJev(promise);
    const plain = flowAgent(plainJev.port, { partials: false });
    await atPayment(plain);
    const before = await firstSegment(plain, 'kal kar dunga', advance);
    expect(before).toEqual({ ms: JEV_MS, segment: TOMORROW });

    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: false });
    // The caller is still speaking (the STT's end of turn comes later): the decision runs now.
    await vi.advanceTimersByTimeAsync(600);
    const after = await firstSegment(agent, 'Kal kar dunga.', advance);
    expect(after).toEqual({ ms: 0, segment: TOMORROW });
    expect(before.ms - after.ms).toBe(JEV_MS);
    expect(jev.requests).toHaveLength(1);
    expect(agent.flow!.state).toMatchObject({ node: 'ptp_tomorrow', listen: 'wrapup' });
    expect(agent.speculationMetrics.decision).toEqual({
      started: 1,
      modelCalls: 1,
      reused: 1,
      discarded: 0,
      cancelled: 0,
    });
  });

  it('waits only for what is left of a decision still in flight', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(100);
    // A stable partial skips the debounce, so 100ms of the 300ms round trip is already done.
    expect(await firstSegment(agent, 'kal kar dunga', advance)).toEqual({
      ms: 200,
      segment: TOMORROW,
    });
    expect(jev.requests).toHaveLength(1);
  });

  it('never moves the call on a partial: only the turn that speaks commits', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    const before = { ...agent.flow!.state };
    const path = agent.flow!.path.length;
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.flow!.state).toEqual(before);
    expect(agent.flow!.path).toHaveLength(path);
    expect(agent.decisions.length).toBe(1);
  });

  it('discards a verdict for other words and decides the final transcript itself', async () => {
    const jev = slowJev({ ...promise, kal: { intent: 'other' } });
    const agent = flowAgent(jev.port, {}, { llm: undefined });
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal', stable: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(await firstSegment(agent, 'kal kar dunga', advance)).toEqual({
      ms: JEV_MS,
      segment: TOMORROW,
    });
    expect(jev.requests).toHaveLength(2);
    expect(agent.speculationMetrics.decision).toMatchObject({ reused: 0, discarded: 1 });
  });

  it('reuses a verdict on a prefix of the final words only when the agent allows it', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port, { match: 'prefix' });
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(400);
    const reply = await firstSegment(agent, 'kal kar dunga pakka', advance);
    expect(reply).toEqual({ ms: 0, segment: TOMORROW });
    expect(jev.requests).toHaveLength(1);
  });

  it('cancels a decision in flight for words the final transcript replaced', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal', stable: true });
    await vi.advanceTimersByTimeAsync(100);
    const reply = firstSegment(agent, 'kal kar dunga', advance);
    await settleMs(reply, advance);
    expect(jev.signals[0]!.aborted).toBe(true);
    expect(agent.speculationMetrics.decision).toMatchObject({ cancelled: 1, reused: 0 });
  });

  it('debounces revisions and keeps at most one decision in flight', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port, { debounceMs: 150 });
    await atPayment(agent);
    for (const text of ['k', 'kal', 'kal kar', 'kal kar dun', 'kal kar dunga']) {
      agent.prepare({ turnId: 't-3', text, stable: false });
      await vi.advanceTimersByTimeAsync(50);
    }
    // Only the words that held for 150ms were decided.
    await vi.advanceTimersByTimeAsync(150);
    expect(
      jev.requests.map((request) => (request.state as Record<string, unknown>)['caller_reply']),
    ).toEqual(['kal kar dunga']);
    // Newer stable words arrive while that decision is in flight: they wait for it to settle.
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga pakka', stable: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(jev.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(JEV_MS);
    expect(jev.requests).toHaveLength(2);
    expect(jev.maxInFlight()).toBe(1);
    expect(agent.speculationMetrics.decision).toMatchObject({ started: 2, modelCalls: 2 });
  });

  it('decides a phrase-tier partial with no decision model call at all', async () => {
    const jev = slowJev({});
    const agent = flowAgent(jev.port);
    await agent.respond('', { inputEvent: 'opening', ...call });
    agent.prepare({ turnId: 't-2', text: 'haan ji', stable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await firstSegment(agent, 'Haan ji!', advance)).toMatchObject({ ms: 0 });
    expect(jev.requests).toHaveLength(0);
    expect(agent.speculationMetrics.decision).toMatchObject({
      started: 1,
      modelCalls: 0,
      reused: 1,
    });
  });

  it('decides again when the call moved on between the partial and the final words', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    agent.beginTurn(1);
    await agent.respond('', { inputEvent: 'opening', ...call });
    agent.beginTurn(2);
    const lines = (await agent.respond('yes', call)).split(/(?<=\.) /);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(400);
    // The agent's question finishes playing only now: what the caller answers has changed.
    for (const text of lines)
      agent.onPlayback({ id: text, text, epoch: 2, state: 'completed', evidence: 'confirmed' });
    expect(await firstSegment(agent, 'kal kar dunga', advance)).toEqual({
      ms: JEV_MS,
      segment: TOMORROW,
    });
    expect(jev.requests).toHaveLength(2);
    expect((jev.requests[1]!.state as Record<string, unknown>)['agent_last_said']).toContain(
      'make this payment',
    );
  });

  it('decides again when the partial’s decision failed, with the turn’s own deadline', async () => {
    const jev = slowJev({ 'kal kar dunga': new Error('jev unavailable') });
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(400);
    await firstSegment(agent, 'kal kar dunga', advance);
    expect(jev.requests).toHaveLength(2);
    expect(agent.speculationMetrics.decision).toMatchObject({ reused: 0, discarded: 1 });
  });

  it('drops what was prepared for an utterance the driver discards', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(100);
    agent.discard('t-other');
    expect(jev.signals[0]!.aborted).toBe(false);
    agent.discard('t-3');
    expect(jev.signals[0]!.aborted).toBe(true);
    expect(await firstSegment(agent, 'kal kar dunga', advance)).toMatchObject({ ms: JEV_MS });
  });

  it('stamps a reused transition when its turn takes it, not when the partial was decided', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(2_000);
    const takenAt = new Date().toISOString();
    await firstSegment(agent, 'kal kar dunga', advance);
    expect(agent.flow!.path.at(-1)!.at).toBe(takenAt);
  });

  it('leaves alone words the gate would not judge, and agents that turn it off', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: '   ', stable: true });
    const off = flowAgent(jev.port, { partials: false });
    await atPayment(off);
    off.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(jev.requests).toHaveLength(0);
    expect(off.speculationMetrics.decision).toBeUndefined();
  });

  it('does not decide a partial before the call has given its variables', async () => {
    const jev = slowJev(promise);
    const agent = flowAgent(jev.port);
    agent.prepare({ turnId: 't-1', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(jev.requests).toHaveLength(0);
  });

  it('reuses a flat policy’s verdict too, and the turn is judged by it', async () => {
    const decided = (choice: string): DecisionResponse => ({
      modelId: 'jev-1',
      answers: {
        intent: {
          type: 'choice',
          choice,
          confidence: 0.95,
          calibrationVersion: 'jev/c',
          probabilities: {
            pay: choice === 'pay' ? 0.95 : 0.05,
            other: choice === 'pay' ? 0.05 : 0.95,
          },
        },
      },
    });
    const jev = slowJev({ 'i can pay today': decided('pay') });
    const agent = new AgentBehavior(
      AgentConfig.parse({
        name: 'Collections',
        mode: 'agent',
        decision: {
          enabled: true,
          questions: [
            {
              type: 'choice',
              id: 'intent',
              instructions: 'What does the caller want?',
              threshold: 0.8,
              fallback: 'llm',
              options: [
                { key: 'pay', description: 'Pays now', outcome: { say: 'Sending the link.' } },
                { key: 'other', description: 'Anything else', outcome: {} },
              ],
            },
          ],
        },
      }),
      undefined,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1', decision: jev.port },
    );
    await agent.respond('hello');
    agent.prepare({ turnId: 't-2', text: 'I can pay today', stable: true });
    await vi.advanceTimersByTimeAsync(400);
    const iterator = agent.respondStream('I can pay today', {})[Symbol.asyncIterator]();
    const first = iterator.next();
    expect(await settleMs(first, advance)).toBe(0);
    expect((await first).value).toBe('Sending the link.');
    expect(jev.requests).toHaveLength(2);
    expect(agent.decisions.at(-1)!.result).toMatchObject({ kind: 'decided', modelId: 'jev-1' });
  });
});

describe('peekHistory', () => {
  it('returns what the next caller line would see, without recording anything', () => {
    const conversation = new PlaybackConversation();
    conversation.beginTurn(1);
    conversation.user('hello');
    conversation.generated('Hi, how can I help?');
    conversation.played({
      id: 'r-1',
      text: 'Hi, how can I help?',
      epoch: 1,
      state: 'completed',
      evidence: 'estimated',
    });
    const peeked = peekHistory(conversation);
    expect(peeked).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '[Playback evidence: estimated.] Hi, how can I help?' },
    ]);
    expect(peekHistory(conversation)).toEqual(peeked);
    expect(conversation.user('next')).toEqual(peeked);
  });
});
