import type { Step } from './call4-timeline.ts';

/**
 * Maya call 10d5ef30 (2026-10-12, main 519966b, Waves 6–8b live) as the turn detector heard it,
 * from its call dump (/tmp/ovo/call5-calldump.json). Times are ms from the call's first engine
 * event (15:54:58.958 UTC + 30 ms, the opening's turn decision). Measured: every interim and final
 * (the engine's `user.transcript` times), when the agent's lines started and stopped, and each
 * turn's VAD stop, which is its `endpointMs` (less the VAD's 200 ms hangover) before it ended or,
 * with a `vad_stop_wait`, that long before its final. Modelled, and marked so: when a VAD run
 * started (the turn's `user.turn` start when the VAD opened it), and Scribe's answer to a host
 * commit (its `stt_finalize`).
 */
export const SAID5 = {
  turn1: '"Hey, Maya, can you please tell me what places are nice in-"',
  turn2: 'Yeah. "... Europe in December, January, times?"',
  turn12: 'No, umm...',
  turn13a: "Umm, I'm just thinking of whether we should go this year or next.",
  turn14b: "don't make it, like, too far away or impossible to reach.",
  turn15: 'And stuff like that. I mean, it should still be a',
  turn16: 'built-in.',
  turn5: 'अम्म... Can you tell me about how pricey flights are and things like that?',
  turn6: 'Yeah. Also, what more...',
  turn21: 'Yeah, yeah, sure.',
  turn22: 'Never mind. Thank you.',
};

/** Turns 1–2: "…what places are nice in-" and, 2 s later, "… Europe in December, January times?". */
export function call5Opening(): Step[] {
  return [
    { at: 14, agent: 'question' },
    { at: 4_946, agent: 'stop' },
    // turn-1: the VAD opened the turn (6.872 s) and stayed on 1.6 s past the final (VAD stop
    // 12.232 s: endpointMs 451 at 12.483 s); the caller went on in it.
    { at: 6_872, vad: 'vad.start' },
    { at: 8_386, interim: '"Maya", can you please-' },
    { at: 9_289, interim: '"Hey, Maya, can you please tell me what' },
    { at: 10_259, interim: '"Hey, Maya, can you please tell me what places are' },
    { at: 10_591, final: SAID5.turn1 },
    { at: 12_232, vad: 'vad.stop' },
    // turn-2: words from 12.576 s, with no VAD run (Scribe heard the soft speech; the VAD did
    // not). Live this was a turn of its own, ended by the stall and Scribe's final at 15.427 s.
    // Modelled: Scribe answering a host commit with the words it has then, 347 ms later (its
    // final came 347 ms after live turn 2's commit), and starting a new segment.
    { at: 12_576, commit: 'Yeah. "... Europe in December, January,', latencyMs: 347 },
    { at: 12_576, commit: 'times?"', latencyMs: 347 },
    { at: 12_576, interim: 'Yeah. "... Europe in December, January,' },
    { at: 13_580, interim: 'times?"' },
  ];
}

/**
 * Turns 12–13: "No, umm..." (rule hold, 1486 ms) and, the VAD opening again 14 ms after it ended,
 * "Umm, I'm just thinking…". The agent's last line ("Want more detail?") stopped at 171.548 s.
 * The replay ends with turn 13's first sentence (its VAD stop there is modelled): live, the
 * caller went on to two more questions in the same turn.
 */
export function call5Hesitation(): Step[] {
  return [
    { at: 160_148, agent: 'start' },
    { at: 170_600, agent: 'question' },
    { at: 171_548, agent: 'stop' },
    // turn-12: VAD 173.694–174.854 s (its stop 583 ms before the final).
    { at: 173_694, vad: 'vad.start' },
    { at: 174_785, interim: 'No,' },
    { at: 174_854, vad: 'vad.stop' },
    { at: 175_437, final: SAID5.turn12 },
    // turn-13: the VAD opened it at 176.154 s.
    { at: 176_154, vad: 'vad.start' },
    { at: 177_505, interim: 'Ummm...' },
    { at: 178_413, interim: "Umm, I'm just thinking" },
    { at: 179_485, interim: "Umm, I'm just thinking of whether we should" },
    { at: 180_390, interim: "Umm, I'm just thinking of whether we should go this year or next" },
    { at: 180_480, final: SAID5.turn13a },
    { at: 180_600, vad: 'vad.stop' },
  ];
}

/**
 * Turns 14–16, from turn 14's last words: "…impossible to reach." then, 0.7 s later, "And stuff
 * like that. I mean, it should still be a" (rule hold, 1152 ms) and "built-in." 3 s after its
 * final. The agent's question ("Would you be open to adding a few nights in the Arctic?") stopped
 * at 206.935 s.
 */
export function call5Fragment(): Step[] {
  return [
    { at: 190_604, agent: 'start' },
    { at: 205_000, agent: 'question' },
    { at: 206_935, agent: 'stop' },
    // turn-14's second sentence: VAD to 215.714 s (565 ms before its final); its start modelled.
    { at: 214_600, vad: 'vad.start' },
    { at: 215_211, interim: "don't make it, like, too far away or" },
    { at: 215_714, vad: 'vad.stop' },
    { at: 216_279, final: SAID5.turn14b },
    // turn-15: VAD from 216.955 s to 219.574 s (endpointMs 1152 at 220.526 s).
    { at: 216_955, vad: 'vad.start' },
    { at: 217_422, interim: 'And stuff' },
    { at: 218_428, interim: "And stuff like that. I mean, it's" },
    { at: 219_150, final: SAID5.turn15 },
    { at: 219_574, vad: 'vad.stop' },
    // turn-16: "built-in." with no VAD run (rule answer, 635 ms); Scribe's final 383 ms after the
    // commit its interim got 250 ms later.
    { at: 222_157, interim: SAID5.turn16 },
    { at: 222_157, commit: SAID5.turn16, latencyMs: 383 },
  ];
}

/**
 * Turns 21–22: "Yeah, yeah, sure." (rule silence, 641 ms) to "Would you like me to draft it?", then
 * "Never mind. Thank you." (rule complete, 697 ms) to "What cities and dates have you settled on so
 * far?". Each VAD stop is its `endpointMs` less the 200 ms hangover before the turn ended.
 */
export function call5Closing(): Step[] {
  return [
    { at: 280_000, agent: 'question' },
    { at: 286_667, agent: 'stop' },
    { at: 288_297, vad: 'vad.start' },
    { at: 288_826, vad: 'vad.stop' },
    { at: 289_257, final: SAID5.turn21 },
    { at: 290_477, agent: 'start' },
    { at: 296_600, agent: 'question' },
    { at: 297_667, agent: 'stop' },
    { at: 299_877, vad: 'vad.start' },
    { at: 300_940, vad: 'vad.stop' },
    { at: 300_967, interim: 'Never' },
    { at: 301_437, final: SAID5.turn22 },
  ];
}

/**
 * Turns 5–6: "…how pricey flights are…" (VAD from 66.987 s, rule long, 753 ms), then the 18 s
 * answer, and over it "Yeah. Also, what more..." with no VAD run behind it (live turn 6 started on
 * its first interim and never stopped). Turn 5's interims and final are measured; its VAD start is
 * its `user.turn` start.
 */
export function call5OverAgent(): Step[] {
  return [
    { at: 66_987, vad: 'vad.start' },
    { at: 67_917, final: 'अम्म...' },
    { at: 69_037, interim: 'Can you tell me about-' },
    { at: 69_937, interim: 'Can you tell me about how price is' },
    { at: 70_937, interim: 'Can you tell me about how pricey flights are and things like' },
    { at: 70_568, vad: 'vad.stop' },
    { at: 71_117, final: 'Can you tell me about how pricey flights are and things like that?' },
    { at: 72_617, agent: 'start' },
    { at: 78_997, interim: 'Yeah. Also,' },
    { at: 79_897, interim: 'Yeah. Also, what more...' },
    { at: 80_907, interim: 'Yeah. Also, what more ?' },
    { at: 82_747, final: SAID5.turn6 },
    { at: 88_507, agent: 'question' },
    { at: 90_967, agent: 'stop' },
  ];
}
