import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type Inference,
  type InferenceRequest,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement, InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { AgentBehavior } from '../../behaviors/src/index.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { unclearForSearch } from '../../plugin-llm-openai/src/search-voice.ts';
import calls from './fixtures/calls-4-7-turns.json' with { type: 'json' };
import { driverHarness, sleep } from './turn-harness.ts';

/**
 * Wave 12: the founder's Maya calls 4–7 (e8a43f65, 10d5ef30, 4f1a919d, 8cb76efc), every caller turn
 * that was answered, through the turn driver and the real agent behaviour, in order and each heard
 * to its end. The fixture is each call's per-turn summaries (`/v1/calls/:id/turns`): the caller's
 * words and what the agent said. The model is scripted to say what it said live, less what the
 * platform added (a filler, the search line, an offer of more) and with the platform's own
 * replacements undone (the clarification and the ask-again lines were the uncertainty line;
 * "Shall I end the call?" was an `end_call`); it searches when the turn searched live and it is
 * sent the tool, and takes 4.2 s then (1.3 s without). Turns merged live (no reply) are left out.
 * Endpointing is the turns lane's: each turn ends 600 ms after its words. With
 * OVO_REPLAY_REPORT set to a path, what each turn heard and when is written there as JSON.
 */
interface Turn {
  turnId: string;
  caller: string;
  agent: string | null;
  searched: boolean;
}
const CALLS = calls as Record<string, { callId: string; turns: Turn[] }>;

const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";
const UNSURE = "I'm not completely sure about that. Want me to look it up?";
const FILLER = { text: 'One moment.', afterMs: 1500 };
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
const PLATFORM = [FILLER.text, ANNOUNCE.line!, ANNOUNCE.stillLine!];
const OFFERS = ['Want more detail?', 'Want to hear more?', 'Would you like more on that?'];
const REPLACED = [
  'Please clarify your question.',
  'Sorry, could you say that again?',
  "Sorry, I still didn't catch that. Could you put it another way?",
];
const ASK_TO_END = 'Shall I end the call?';

/** What the model said live for a turn: its words, or an `end_call` with the goodbye. */
function modelSaid(agent: string): { text?: string; goodbye?: string } {
  let text = agent.trim();
  for (let again = true; again;) {
    again = false;
    for (const line of PLATFORM)
      if (text.startsWith(`${line} `) || text === line) {
        text = text.slice(line.length).trim();
        again = true;
      }
  }
  for (const offer of [...OFFERS, 'Interested in more detail?'])
    if (text.endsWith(` ${offer}`)) text = text.slice(0, -offer.length).trim();
  if (text === ASK_TO_END) return { goodbye: 'Goodbye!' };
  if (REPLACED.includes(text)) return { text: UNSURE };
  if (/goodbye|have a (?:wonderful|lovely) trip/iu.test(text)) return { goodbye: text };
  return { text };
}

async function replayCall(turns: Turn[]) {
  const clock = new FakeClock();
  const listeners = new Set<(activity: InferenceActivity) => void>();
  const byWords = new Map(turns.map((turn) => [turn.caller, turn]));
  const asked: { turnId: string; tools: boolean }[] = [];
  const sends = (request: Omit<InferenceRequest, 'signal'>) =>
    request.providerTools === true ||
    (request.providerTools !== false && !unclearForSearch(request));
  let ids = 0;
  const model: Inference & {
    observeActivity(listener: (activity: InferenceActivity) => void): () => void;
  } = {
    generate: () => Promise.reject(new Error('streamed only')),
    async *stream(request): AsyncIterable<InferenceStreamEvent> {
      const turn = byWords.get(request.input);
      const tools = sends(request);
      asked.push({ turnId: turn?.turnId ?? '?', tools });
      const said = turn?.agent ? modelSaid(turn.agent) : { text: 'Sure.' };
      const searches = Boolean(turn?.searched && tools);
      const id = `ws-${++ids}`;
      if (searches) {
        await sleep(clock, 600, request.signal);
        if (request.signal.aborted) return;
        const started = { phase: 'started' as const, tool: 'web_search', id, atMs: clock.now() };
        for (const listener of listeners)
          listener({ ...started, signal: request.signal, announce: ANNOUNCE });
      }
      await sleep(clock, searches ? 3600 : 1300, request.signal);
      if (request.signal.aborted) return;
      if (said.text)
        for (const delta of said.text.match(/.{1,8}/gsu) ?? []) yield { kind: 'text-delta', delta };
      else
        yield {
          kind: 'tool',
          toolId: 'end_call',
          input: { goodbye: said.goodbye, reason: 'done' },
        };
      yield { kind: 'finish' };
    },
    sendsProviderTools: sends,
    observeActivity(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      language: 'en-IN',
      uncertainty: UNSURE,
      opening: { lines: [GREETING] },
      ending: { llmTool: true },
      reply: { firstPhraseWords: 0 },
    }),
    model,
    { execute: async () => ({ state: 'succeeded' }) as never },
    {
      workspaceId: 'w-1',
      sessionId: 's-1',
      now: () => new Date(Date.parse('2026-10-14T03:00:00Z') + clock.now()),
    },
  );
  const h = driverHarness(clock, behavior, {
    ttsMs: 150,
    playMs: 3000,
    fillerPlayMs: 1000,
    fillers: [...PLATFORM, ASK_TO_END],
  });
  listeners.add((activity) => h.driver.inferenceActivity(activity));
  await h.greet();
  const heard: { turnId: string; caller: string; heard: [string, number][]; tools: boolean[] }[] =
    [];
  for (const turn of turns.filter((each) => each.agent !== null)) {
    if (h.endings.length) break;
    h.turn.started(turn.turnId);
    h.driver.decide({ type: 'turn.partial', turnId: turn.turnId, text: turn.caller, stable: true });
    await clock.advanceAsync(600);
    h.turn.stopped(turn.turnId, turn.caller, FILLER);
    const stopped = clock.now();
    await clock.advanceAsync(40_000);
    heard.push({
      turnId: turn.turnId,
      caller: turn.caller,
      heard: h.audio
        .filter((line) => line.atMs >= stopped)
        .map((line) => [line.text, line.atMs - stopped] as [string, number]),
      tools: asked.filter((entry) => entry.turnId === turn.turnId).map((entry) => entry.tools),
    });
  }
  return heard;
}

const words = (heard: [string, number][]) => heard.map(([line]) => line);
const isPlatform = (line: string) => PLATFORM.includes(line);

describe('Maya calls 4–7 replayed, reply side (Wave 12)', () => {
  const report: Record<string, unknown> = {};
  for (const [name, { callId, turns }] of Object.entries(CALLS))
    it(`${name} (${callId}): every turn heard an answer, none of them canned or cited`, async () => {
      const heard = await replayCall(turns);
      report[name] = heard;
      if (process.env.OVO_REPLAY_REPORT)
        writeFileSync(process.env.OVO_REPLAY_REPORT, JSON.stringify(report, null, 1));
      for (const turn of heard) {
        const said = words(turn.heard);
        // Every caller turn that is not a merge gets an audible answer.
        expect(
          said.filter((line) => !isPlatform(line)),
          turn.turnId,
        ).not.toEqual([]);
        expect(said, turn.turnId).not.toContain('Please clarify your question.');
        expect(said.join(' '), turn.turnId).not.toMatch(/[\uE200-\uE2FF]|cite ?turn\d/u);
      }
      // A plain yes to an offer of more is never asked to be said again (call 8cb76efc turn 29).
      for (const [index, turn] of heard.entries()) {
        const before = words(heard[index - 1]?.heard ?? []).at(-1) ?? '';
        if (OFFERS.includes(before) && /^(?:yeah|yes)\.?$/iu.test(turn.caller.trim()))
          expect(words(turn.heard), turn.turnId).not.toContain('Sorry, could you say that again?');
      }
      // At most one offer of more in any four answers in a row (F7).
      const offered = heard.map((turn) => OFFERS.includes(words(turn.heard).at(-1) ?? ''));
      for (let at = 0; at + 4 <= offered.length; at++)
        expect(offered.slice(at, at + 4).filter(Boolean).length, `from ${at}`).toBeLessThanOrEqual(
          1,
        );
    });
});
