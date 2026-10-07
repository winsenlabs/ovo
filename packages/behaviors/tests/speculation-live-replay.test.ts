import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPECULATION,
  DecisionSpeculation,
  endsSentence,
  type DecisionGateResult,
  type DecisionTurn,
  type SpeculationPolicy,
} from '../src/index.ts';

/** What one live call's caller and agent did, as `fixtures/speculation-live-calls.json` keeps it. */
type LiveEvent =
  | { t: number; k: 'interim' | 'final' | 'stopped'; text: string }
  | { t: number; k: 'started' | 'played' };

const LIVE = JSON.parse(
  readFileSync(new URL('./fixtures/speculation-live-calls.json', import.meta.url), 'utf8'),
) as { calls: { call: string; events: LiveEvent[] }[] };
/** Jev's round trip on those calls (decision.made durationMs, p50 ~400ms). */
const JEV_MS = 400;
const VERDICT: DecisionGateResult = { kind: 'off' };

/** Wave 6 behaviour: every revision that holds for the debounce, with no limit per utterance. */
const WAVE_6: Partial<SpeculationPolicy> = { partialEnding: 'any', maxPartialCalls: Infinity };

/**
 * Replays a live call's transcript stream through the speculation the agent runs, as the turn
 * detector announces it (`plugin-turns/src/announce.ts`): the utterance so far, stable when every
 * word is from a final segment. Each caller turn takes the verdict when it stops; the state the
 * verdict depends on moves when a turn commits and when an agent line finishes playing.
 */
async function replay(events: readonly LiveEvent[], policy: Partial<SpeculationPolicy> = {}) {
  const speculation = new DecisionSpeculation(
    { ...DEFAULT_SPECULATION, ...policy },
    (_turn, signal) => ({
      verdict: new Promise<DecisionGateResult>((resolve, reject) => {
        const timer = setTimeout(() => resolve(VERDICT), JEV_MS);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
      asked: true,
    }),
  );
  let state = 0;
  let utterance = 0;
  let finals: string[] = [];
  let interim: string | undefined;
  let announced = '';
  /** How much of the decision wait each reusing turn skipped, ms. */
  const saved: number[] = [];
  const turn = (input: string) => ({ input }) as DecisionTurn;
  const start = Date.now();
  for (const event of events) {
    await vi.advanceTimersByTimeAsync(Math.max(0, start + event.t - Date.now()));
    if (event.k === 'started') {
      utterance += 1;
      finals = [];
      interim = undefined;
    } else if (event.k === 'interim' || event.k === 'final') {
      if (event.k === 'final') {
        finals.push(event.text);
        interim = undefined;
      } else interim = event.text;
      const view = [...finals, ...(interim === undefined ? [] : [interim])].join(' ');
      if (!view || view === announced) continue;
      announced = view;
      speculation.offer(`u-${utterance}`, turn(view), String(state), interim === undefined);
    } else if (event.k === 'stopped') {
      const takenAt = Date.now();
      const pending = speculation.take(
        turn(event.text),
        String(state),
        new AbortController().signal,
      );
      void pending?.then((verdict) => {
        if (verdict) saved.push(JEV_MS - (Date.now() - takenAt));
      });
      state += 1;
      finals = [];
      interim = undefined;
      announced = '';
    } else state += 1;
  }
  await vi.advanceTimersByTimeAsync(JEV_MS);
  return {
    ...speculation.metrics,
    wasted: speculation.metrics.discarded + speculation.metrics.cancelled,
    savedMs: saved.reduce((sum, ms) => sum + ms, 0),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('decision speculation on the live calls of 2026-10-07 (P11)', () => {
  it('reproduces the waste: most decisions on partials were billed and thrown away', async () => {
    const callB = LIVE.calls.find((call) => call.call === '8cbac365')!;
    const before = await replay(callB.events, WAVE_6);
    // Live: 129 Jev calls, 25 reused, 83 discarded, 26 cancelled.
    expect(before.modelCalls).toBeGreaterThan(120);
    expect(before.wasted).toBeGreaterThan(before.modelCalls / 2);
  });

  it.each(['8cbac365', '4e4d2228'])(
    'call %s: far fewer calls and less waste, with the same latency won',
    async (id) => {
      const { events } = LIVE.calls.find((call) => call.call === id)!;
      const before = await replay(events, WAVE_6);
      const after = await replay(events);
      expect(after.modelCalls).toBeLessThanOrEqual(before.modelCalls * 0.8);
      expect(after.wasted).toBeLessThanOrEqual(before.wasted * 0.5);
      expect(after.reused).toBeGreaterThanOrEqual(before.reused);
      expect(after.savedMs).toBeGreaterThanOrEqual(before.savedMs);
      expect(after.skipped).toBeGreaterThan(0);
    },
  );

  it('reads a partial as a finished sentence only when the STT ended one', () => {
    for (const text of ['Yes, sir.', 'Okay, stop.', 'Hello?', 'ओके।', 'Don’t get upset!"'])
      expect(endsSentence(text), text).toBe(true);
    for (const text of ['Can you please', 'I am-', 'What number should I call,', 'No, I…'])
      expect(endsSentence(text), text).toBe(false);
    expect(endsSentence('I was saying...')).toBe(false);
  });
});

describe('the waste limits on revisable partials', () => {
  const decide = () => {
    const asked: string[] = [];
    const speculation = new DecisionSpeculation(
      { debounceMs: 150, match: 'exact', partialEnding: 'sentence', maxPartialCalls: 2 },
      (turn) => {
        asked.push(turn.input);
        return { verdict: Promise.resolve(VERDICT), asked: true };
      },
    );
    const offer = async (text: string, stable = false, turnId = 'u-1') => {
      speculation.offer(turnId, { input: text } as DecisionTurn, 's', stable);
      await vi.advanceTimersByTimeAsync(200);
    };
    return { speculation, asked, offer };
  };

  it('decides unpunctuated partials on the debounce alone until the STT punctuates one', async () => {
    const { asked, offer, speculation } = decide();
    // An STT that does not punctuate partials (AssemblyAI's are unformatted) keeps its latency win.
    await offer('kal kar dunga');
    await offer('kal kar dunga pakka');
    expect(asked).toEqual(['kal kar dunga', 'kal kar dunga pakka']);
    expect(speculation.metrics.skipped).toBe(0);
    // From the first punctuated partial on, words cut mid-phrase wait for the sentence to end.
    await offer('Haan ji, kal', false, 'u-2');
    await offer('Haan ji, kal kar dunga.', false, 'u-2');
    expect(asked.slice(2)).toEqual(['Haan ji, kal kar dunga.']);
    expect(speculation.metrics.skipped).toBe(1);
  });

  it('caps model calls per utterance but always decides stable words', async () => {
    const { asked, offer } = decide();
    await offer('Yes.');
    await offer('Yes. I know.');
    await offer('Yes. I know. Go on.');
    await offer('Yes. I know. Go on. Fine.', true);
    expect(asked).toEqual(['Yes.', 'Yes. I know.', 'Yes. I know. Go on. Fine.']);
    await offer('Next one.', false, 'u-2');
    expect(asked.at(-1)).toBe('Next one.');
  });
});
