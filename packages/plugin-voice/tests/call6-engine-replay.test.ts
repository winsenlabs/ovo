import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  endingLines,
  type Inference,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement, InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { AgentBehavior } from '../../behaviors/src/index.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { unclearForSearch } from '../../plugin-llm-openai/src/search-voice.ts';
import { driverHarness, sleep } from './turn-harness.ts';

/**
 * Wave 10: Maya call 4f1a919d (2026-10-13 07:49:51–07:52:55 UTC, main 54fd9ea) through the turn
 * driver and the real agent behaviour, ms from each turn's endpoint decision, as the call's
 * engine events have them (/tmp/ovo/call6-events.jsonl):
 * - turn 7 "Chennai, Chennai." decided at 07:51:44.525; "Madras." (turn 8) started 275 ms later
 *   and was decided at 1,022 ms, while turn 7's search ran (started while the caller spoke, so no
 *   search line); "One moment." at 1,500 ms; turn 7's answer at 3,822 ms (first segment). Turn 8
 *   waited 17.8 s for that answer to play, then its model request (2,373 ms, no search tool: the
 *   call asked ahead on "Madras." had searched) came back with end_call, said as "Shall I end
 *   the call?" after "One moment." at 1,500 ms.
 * - turn 11 "No, okay, I'll take it later. Thank you so much." after "…Which day works better for
 *   you?": "One moment." at 1,500 ms, the model's end_call at 1,709 ms, said as "Shall I end the
 *   call?"; turn 12 "Yeah, yeah.": "One moment." at 1,500 ms, the goodbye at 1,577 ms.
 * TTS first byte 150 ms (the call's 137–157); fixed lines are clips (0 ms). The model's answer to
 * "Madras." once told when it was said is modelled: 1,145 ms, as the call's other requests with
 * no search tool (req_383c8a20, 1,145 ms).
 */
const SAID = {
  turn6: 'Yeah, uh, not about Budapest, but... What is, uh, best way to fly to Europe from...',
  turn6Reply: 'I didn’t catch the departure city. Could you say it again?',
  turn7: 'Chennai, Chennai.',
  turn7Reply:
    'One ticket with a single stop is easiest. Which European city are you heading to, and when?',
  turn8: 'Madras.',
  turn8Reply: 'Madras is the old name for Chennai.',
  turn10: '20. December 20th or 21st?',
  turn10Reply: 'Lufthansa flies nonstop on both days. Which day works better for you?',
  turn11: "No, okay, I'll take it later. Thank you so much.",
  turn12: 'Yeah, yeah.',
};
const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";
const GOODBYE = 'You’re very welcome. Have a lovely trip, and goodbye!';
const END = { goodbye: GOODBYE, reason: 'Caller confirmed they are ready to end the call.' };
const FILLER = { text: 'One moment.', afterMs: 1500 };
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
const LINES = endingLines('en-IN')!;
const CLIPS = [FILLER.text, ANNOUNCE.line!, ANNOUNCE.stillLine!, LINES.ask, LINES.goodbye];
const TTS_MS = 150;
const PLAY_MS = 3000;
const T0 = Date.parse('2026-10-13T07:49:51Z');

interface Scripted {
  ms: number;
  text?: string;
  endCall?: boolean;
  searchAtMs?: number;
}

/** The model as it answered each of the call's words (see above). */
function script(request: InferenceRequest): Scripted {
  if (request.input === SAID.turn6) return { ms: 760, text: SAID.turn6Reply };
  if (request.input === SAID.turn7) return { ms: 3822, text: SAID.turn7Reply, searchAtMs: 600 };
  if (request.input === SAID.turn8)
    // Told the words came before the answer, it reads them with "Chennai, Chennai." (modelled).
    return request.context.includes('straight after')
      ? { ms: 1145, text: SAID.turn8Reply }
      : { ms: 2373, endCall: true };
  if (request.input === SAID.turn10) return { ms: 1713, text: SAID.turn10Reply };
  if (request.input === SAID.turn11) return { ms: 1709, endCall: true };
  if (request.input === 'Thank you.') return { ms: 1400, endCall: true };
  if (request.input === SAID.turn12) return { ms: 1577, endCall: true };
  return { ms: 1000, text: 'Sure.' };
}

function replay() {
  const clock = new FakeClock();
  const requests: InferenceRequest[] = [];
  let searched: ((activity: InferenceActivity) => void) | undefined;
  const model: Inference = {
    generate: () => Promise.reject(new Error('streamed only')),
    async *stream(request) {
      requests.push(request);
      const reply = script(request);
      let waited = 0;
      if (reply.searchAtMs !== undefined && request.providerTools !== false) {
        await sleep(clock, reply.searchAtMs, request.signal);
        waited = reply.searchAtMs;
        const activity = {
          phase: 'started' as const,
          tool: 'web_search',
          id: `ws-${requests.length}`,
        };
        searched?.({ ...activity, atMs: clock.now(), signal: request.signal, announce: ANNOUNCE });
      }
      await sleep(clock, reply.ms - waited, request.signal);
      if (request.signal.aborted) return;
      if (reply.text) yield { kind: 'text-delta', delta: reply.text };
      else yield { kind: 'tool', toolId: 'end_call', input: END };
      yield { kind: 'finish' };
    },
    // As the OpenAI binding decides it (plugin-llm-openai `unclearForSearch`).
    sendsProviderTools: (request) => request.providerTools !== false && !unclearForSearch(request),
  };
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      language: 'en-IN',
      opening: { lines: [GREETING] },
      ending: { llmTool: true },
      reply: { firstPhraseWords: 0 },
    }),
    model,
    { execute: async () => ({ state: 'succeeded' }) as never },
    { workspaceId: 'w-1', sessionId: 's-1', now: () => new Date(T0 + clock.now()) },
  );
  const h = driverHarness(clock, behavior, {
    ttsMs: TTS_MS,
    playMs: PLAY_MS,
    fillerPlayMs: 1000,
    fillers: CLIPS,
  });
  searched = (activity) => h.driver.inferenceActivity(activity);
  const stopped = (turnId: string, words: string) => {
    h.turn.stopped(turnId, words, FILLER);
    return clock.now();
  };
  /** What the caller heard from `from` on: each line and when it started, ms from `from`. */
  const heard = (from: number) =>
    h.audio.filter((line) => line.atMs >= from).map((line) => [line.text, line.atMs - from]);
  return { clock, h, requests, behavior, stopped, heard };
}

/** Turn 6 answered, and the call 30 s in: end_call is past its minimums from turn 7 on. */
async function intoTurn7(r: ReturnType<typeof replay>) {
  await r.h.greet();
  r.stopped('turn-6', SAID.turn6);
  await r.clock.advanceAsync(30_000);
}

describe('call 4f1a919d B1: "Madras." said while "Chennai, Chennai." was being answered', () => {
  it('turns 7–8: is not asked ahead, and is answered for what it is, with no filler', async () => {
    const r = replay();
    await intoTurn7(r);
    const turn7 = r.stopped('turn-7', SAID.turn7);
    await r.clock.advanceAsync(275);
    r.h.turn.started('turn-8');
    await r.clock.advanceAsync(1022 - 275);
    // The STT's final, as a stable partial, then the endpoint.
    r.h.driver.decide({ type: 'turn.partial', turnId: 'turn-8', text: SAID.turn8, stable: true });
    r.stopped('turn-8', SAID.turn8);
    await r.clock.advanceAsync(30_000);

    // Before: a request on "Madras." asked ahead at 1,022 ms (live it searched, 5.1 s, billed).
    expect(r.requests.map((request) => request.input)).toEqual([
      SAID.turn6,
      SAID.turn7,
      SAID.turn8,
    ]);
    const [first, second] = SAID.turn7Reply.split(/(?<=\.) /u);
    // Each line's audio 150 ms after the one before it ends (this harness synthesises in turn).
    const answered = 3822 + 2 * (TTS_MS + PLAY_MS);
    // Before: ["One moment.", answered + 1500], ["Shall I end the call?", answered + 2373].
    expect(r.heard(turn7)).toEqual([
      [FILLER.text, 1500],
      [first, 3822 + TTS_MS],
      [second, 3822 + 2 * TTS_MS + PLAY_MS],
      [SAID.turn8Reply, answered + 1145 + TTS_MS],
    ]);
    expect(r.behavior.isComplete()).toBe(false);
    // Its request: the whole history, turn 7's answer included, no search tool, and the note.
    const madras = r.requests.at(-1)!;
    expect(madras.history?.map((entry) => entry.content).slice(-3)).toEqual([
      SAID.turn7,
      first,
      second,
    ]);
    expect(madras.providerTools).toBe(false);
    expect(madras.context).toContain('straight after "Chennai, Chennai."');
  });
});

/** Turn 10 answered, ending on its question. */
async function intoTurn11(r: ReturnType<typeof replay>) {
  await intoTurn7(r);
  r.stopped('turn-10', SAID.turn10);
  await r.clock.advanceAsync(20_000);
}

describe('call 4f1a919d B3 and L3: turn 11, a decline with thanks', () => {
  it('is told goodbye with no filler and no "Shall I end the call?", and the call ends', async () => {
    const r = replay();
    await intoTurn11(r);
    const turn11 = r.stopped('turn-11', SAID.turn11);
    await r.clock.advanceAsync(10_000);
    // Before: ["One moment.", 1500], ["Shall I end the call?", 1709]; then turn 12 to end it.
    expect(r.heard(turn11)).toEqual([[GOODBYE, 1709 + TTS_MS]]);
    expect(r.h.endings).toEqual([
      'behavior_completed:llm:end_call:Caller confirmed they are ready to end the call.',
    ]);
  });
});

describe('call 4f1a919d L2 and L3: turn 12, a yes to "Shall I end the call?"', () => {
  it('is told the fixed goodbye at once, with no filler and no model request', async () => {
    const r = replay();
    await intoTurn11(r);
    // "Thank you." alone is still asked about (Wave 9).
    const thanked = r.stopped('turn-11', 'Thank you.');
    await r.clock.advanceAsync(10_000);
    expect(r.heard(thanked)).toEqual([[LINES.ask, 1400]]);
    const asked = r.requests.length;
    const turn12 = r.stopped('turn-12', SAID.turn12);
    await r.clock.advanceAsync(10_000);
    // Before: ["One moment.", 1500], [GOODBYE, 1577 + 150] after a 1,577 ms model request.
    expect(r.heard(turn12)).toEqual([[LINES.goodbye, 0]]);
    expect(r.requests).toHaveLength(asked);
    expect(r.h.endings).toEqual([
      'behavior_completed:llm:end_call:Caller confirmed they are ready to end the call.',
    ]);
  });
});

describe('review of ec1194c: a short yes whose reply runs one of the agent’s own tools', () => {
  const ASKED = 'Shall I check the open slots for you?';
  const SLOTS = 'You have slots at 3 and 5 pm.';

  /** "Yes, please.": the model calls `check_slots` after `toolAtMs`, which runs 3 s; then 900 ms. */
  async function heard(toolAtMs: number) {
    const clock = new FakeClock();
    const model: Inference = {
      generate: () => Promise.reject(new Error('streamed only')),
      async *stream(request) {
        await sleep(clock, request.results.length ? 900 : toolAtMs, request.signal);
        if (request.signal.aborted) return;
        if (request.results.length) yield { kind: 'text-delta', delta: SLOTS };
        else yield { kind: 'tool', toolId: 'check_slots', input: {} };
        yield { kind: 'finish' };
      },
      // No web search for a yes: the reply is not looking anything up until it calls the tool.
      sendsProviderTools: () => false,
    };
    const behavior = new AgentBehavior(
      AgentConfig.parse({
        name: 'Maya',
        mode: 'agent',
        language: 'en-IN',
        opening: { lines: [ASKED] },
        allowedTools: ['check_slots'],
        tools: [
          {
            id: 'check_slots',
            connector: 'native',
            effect: 'read',
            description: 'Check the open slots',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        reply: { firstPhraseWords: 0 },
      }),
      model,
      {
        execute: async (request) => {
          await sleep(clock, 3000);
          return { ...request, state: 'succeeded', result: { slots: [3, 5] }, createdAt: 'now' };
        },
      },
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    const h = driverHarness(clock, behavior, {
      ttsMs: TTS_MS,
      playMs: PLAY_MS,
      fillerPlayMs: 1000,
      fillers: [FILLER.text],
    });
    await h.greet();
    h.turn.stopped('turn-1', 'Yes, please.', FILLER);
    const from = clock.now();
    await clock.advanceAsync(10_000);
    return h.audio.filter((line) => line.atMs >= from).map((line) => [line.text, line.atMs - from]);
  }

  it('keeps "One moment." for the tool’s 3 s', async () => {
    // Before: [[SLOTS, 4950]], 4.95 s of silence.
    expect(await heard(900)).toEqual([
      [FILLER.text, 1500],
      [SLOTS, 900 + 3000 + 900 + TTS_MS],
    ]);
  });

  it('plays it once the tool is called, when that comes after the filler was due', async () => {
    expect(await heard(1950)).toEqual([
      [FILLER.text, 2000],
      [SLOTS, 1950 + 3000 + 900 + TTS_MS],
    ]);
  });
});
