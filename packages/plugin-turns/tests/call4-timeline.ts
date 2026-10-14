import { replay } from './replay.ts';

/**
 * Maya call e8a43f65 (2026-10-12, main 6107125, before Wave 8) as the turn detector heard it,
 * rebuilt from its turn summaries (/tmp/ovo/call4-turns.jsonl). Times are ms from 11:06:00 UTC.
 * Each summary's `startedAt` is the turn's VAD stop (or, with no VAD stop, its final), so a turn's
 * VAD stop, its final (`vadStopToFinalMs` less Maya's 450 ms commit silence is Scribe's latency)
 * and, for turn-3, its last words (`endpointMs` before the final) are measured. What the summaries
 * do not hold is modelled, and marked so: when each utterance started (~2.7 words a second), when
 * Scribe's interims landed (about once a second), and when the agent spoke between turns.
 */
export type Step =
  | { at: number; vad: 'vad.start' | 'vad.stop' }
  | { at: number; interim: string }
  | { at: number; final: string }
  /** Scribe's answer to the utterance's host commit, queued as the utterance starts. */
  | { at: number; commit: string; latencyMs: number }
  | { at: number; agent: 'start' | 'question' | 'stop' }
  /** Wave 12: a filler or search line, or the opening's disclosure. */
  | { at: number; agent: 'filler' | 'disclosure' };

export const SAID = {
  turn1: '"We\'re planning to go to Zagreb this..." No, December.',
  turn2: 'I want 21st of December to the 5th.',
  turn3: 'Of January.',
  turn4: "Yeah, we're planning to do Budapest, Vienna,",
  turn5: "in Austria. Then we're planning to go to Zagreb, Prague.",
  turn6: 'Germany, Berlin, and a few other places.',
  turn7: "Ma'am, create a call.",
};

/**
 * The call's caller turns. `gap56` is the modelled silence between "Prague." and "Germany" (from
 * the VAD stop): the utterance is ~2.3–2.8 s long, so it started 0.1–0.6 s after that stop.
 */
export function call4(gap56 = 600): Step[] {
  return [
    // Opening ("…Where are you thinking of going?") from 12.398 s.
    { at: 12_398, agent: 'question' },
    { at: 17_000, agent: 'stop' },
    // turn-1: VAD stop 22.177 (measured); final 792 ms later = 450 + Scribe 342.
    { at: 18_400, vad: 'vad.start' },
    { at: 19_400, interim: "We're planning to go" },
    { at: 20_400, interim: '"We\'re planning to go to Zagreb this..."' },
    { at: 18_400, commit: SAID.turn1, latencyMs: 342 },
    { at: 21_400, interim: SAID.turn1 },
    { at: 22_177, vad: 'vad.stop' },
    // The agent's answer, ending on "What dates are you considering?" (modelled).
    { at: 24_474, agent: 'start' },
    { at: 37_500, agent: 'question' },
    { at: 38_500, agent: 'stop' },
    // turn-2: VAD stop 41.917; its final came 255 ms later, before any host commit (measured).
    { at: 39_400, vad: 'vad.start' },
    { at: 40_400, interim: 'I want 21st' },
    { at: 41_400, interim: SAID.turn2 },
    { at: 41_917, vad: 'vad.stop' },
    { at: 42_172, final: SAID.turn2 },
    // turn-3: no VAD run (a soft "Of January."); its words last changed at 44.178 and the stall
    // committed it, final at 45.975 (both measured: endpointMs 1797 before the final).
    { at: 44_178, interim: SAID.turn3 },
    { at: 44_178, commit: SAID.turn3, latencyMs: 297 },
    // The agent's answer to the dates (modelled), ending on a question.
    { at: 47_211, agent: 'start' },
    { at: 61_000, agent: 'question' },
    { at: 62_000, agent: 'stop' },
    // turn-4: VAD stop 67.077; final 856 ms later = 450 + Scribe 406 (measured).
    { at: 64_000, vad: 'vad.start' },
    { at: 65_000, interim: "Yeah, we're planning" },
    { at: 66_000, interim: "Yeah, we're planning to do Budapest," },
    { at: 64_000, commit: SAID.turn4, latencyMs: 406 },
    { at: 66_900, interim: SAID.turn4 },
    { at: 67_077, vad: 'vad.stop' },
    // turn-5: the caller went on 0.88 s after that VAD stop (inferred: the live reply was held from
    // this VAD start until the hold's 1.8 s no-words release, when it played at 69.758 and was cut).
    // VAD stop 71.857; final 783 ms later = 450 + Scribe 333 (measured).
    { at: 67_958, vad: 'vad.start' },
    { at: 68_958, interim: 'in Austria.' },
    { at: 69_958, interim: "in Austria. Then we're planning" },
    { at: 70_958, interim: "in Austria. Then we're planning to go to Zagreb," },
    { at: 67_958, commit: SAID.turn5, latencyMs: 333 },
    { at: 71_657, interim: SAID.turn5 },
    { at: 71_857, vad: 'vad.stop' },
    // turn-6: VAD stop 74.777; final 812 ms later = 450 + Scribe 362 (measured).
    { at: 71_857 + gap56, vad: 'vad.start' },
    { at: 71_857 + gap56 + 900, interim: 'Germany, Berlin,' },
    { at: 71_857 + gap56, commit: SAID.turn6, latencyMs: 362 },
    { at: 74_500, interim: SAID.turn6 },
    { at: 74_777, vad: 'vad.stop' },
    // The agent's answer (modelled), ending on a question.
    { at: 76_611, agent: 'start' },
    { at: 88_000, agent: 'question' },
    { at: 88_500, agent: 'stop' },
    // turn-7: VAD stop 91.457; final 736 ms later = 450 + Scribe 286 (measured).
    { at: 89_900, vad: 'vad.start' },
    { at: 89_900, commit: SAID.turn7, latencyMs: 286 },
    { at: 90_900, interim: "Ma'am, create a call." },
    { at: 91_457, vad: 'vad.stop' },
  ];
}

/**
 * Runs `steps` through the detector built from `row` on `clock` (the kit's FakeClock); returns
 * its turns, times from 11:06:00.
 */
export function runCall(
  clock: Parameters<typeof replay>[0],
  row: Record<string, unknown>,
  steps: Step[],
) {
  const { f, start } = replayCall(clock, row, steps);
  return f.turns.map((turn) => ({ ...turn, atMs: turn.atMs - start }));
}

/** `runCall`'s replay itself, for its resets as well as its turns. */
export function replayCall(
  clock: Parameters<typeof replay>[0],
  row: Record<string, unknown>,
  steps: Step[],
  options?: Parameters<typeof replay>[2],
) {
  const f = replay(clock, row, options);
  const start = f.clock.now();
  const ordered = steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.at - b.step.at || a.index - b.index);
  for (const { step } of ordered) {
    f.clock.advance(Math.max(0, start + step.at - f.clock.now()));
    if ('vad' in step) f.send({ type: step.vad });
    else if ('interim' in step) f.interim(step.interim);
    else if ('final' in step) f.final(step.final);
    else if ('commit' in step) f.commits(step.commit, step.latencyMs);
    else if (step.agent === 'stop') f.agentStops();
    else if (step.agent === 'filler' || step.agent === 'disclosure') f.agentSays(step.agent);
    else f.agentStarts(step.agent === 'question');
  }
  f.clock.advance(10_000);
  return { f, start };
}
