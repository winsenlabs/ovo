// Promoted in Wave 13 from packages/plugin-turns/tests/call7-timeline.ts so the eval harness and the plugin tests share it.
import type { Step } from './call4-timeline.ts';

/**
 * Maya call 8cb76efc (2026-10-14, main b18b24e, Waves 6–10 live) as the turn detector heard it,
 * from its events (/tmp/ovo/call7-events.jsonl; fixtures/call7-endpoints.json). Times are ms from
 * the call's first engine event (02:54:06.091 UTC, the opening's turn decision). Measured: every
 * interim and final (`user.transcript`), when the agent's lines started and stopped (`speech`
 * evidence), each turn's start (`user.turn`) and its VAD stop: the turn's end less `endpointMs`,
 * plus the VAD's 200 ms hangover, which is also its final less `vad_stop_wait`. Modelled, and
 * marked so: VAD starts the events do not carry, and Scribe's answer to a host commit.
 */
export const SAID7 = {
  turn19: 'Yeah, for both these places.',
  turn20: 'Please.',
  turn21: 'No. Have there been any-',
  turn22a: 'Have there been any-',
  turn22b: 'Crime incidents reported in these two places?',
  turn24a: 'Okay, so yeah, I think, uh, Zagreb is one place and also talk to me about-',
  turn24b: 'Okay ... uh, what happens-',
  turn25: "In Berlin on New Year's Eve?",
};

/**
 * Turns 19–20: "Yeah, for both these places." (rule complete, 609 ms) to "Would you like me to check
 * safety for a particular place, such as Zagreb or Dubrovnik?", then, 1 s after it ended and 93 ms
 * into its search line ("Let me look that up."), "Please." with no VAD run (rule stall, 1873 ms).
 * Live "Please." was queued behind the search and answered after the reply (queueMs 9538): "Sure.
 * In Zagreb and Dubrovnik…", 11.8 s after it, 2.2 s after "Want to hear more?".
 */
export function call7Please(): Step[] {
  return [
    { at: 151_984, agent: 'start' },
    { at: 152_054, agent: 'question' },
    { at: 168_207, agent: 'stop' },
    // turn-19: the VAD opened it (169.950 s) and stopped 404 ms before its final.
    { at: 169_950, vad: 'vad.start' },
    { at: 171_010, vad: 'vad.stop' },
    { at: 171_414, final: SAID7.turn19 },
    // The search line, a filler (bot.started.filler).
    { at: 172_329, agent: 'filler' },
    // turn-20: the stall committed its interim 1.5 s on; Scribe's final came 370 ms later.
    { at: 172_422, interim: SAID7.turn20 },
    { at: 172_422, commit: SAID7.turn20, latencyMs: 370 },
  ];
}

/**
 * Turns 21–22: over the reply to "Please." ("Sure. In Zagreb and Dubrovnik…", from 186.000 s),
 * "No. Have there been any-", which barged in (187.893 s) and ended on the 700 ms hold (rule hold,
 * 1305 ms at 188.895 s); the VAD heard the caller again 0.8 s later (turn-22's start, 189.690 s):
 * "Have there been any- Crime incidents reported in these two places?" (rule long, 774 ms). In
 * between, the LLM wrote "Could you finish your question?" for turn 21, which the engine's 2 s
 * hold after a turn that trailed off kept from playing.
 */
export function call7BrokenOff(): Step[] {
  return [
    { at: 186_000, agent: 'start' },
    // Modelled: the VAD heard "No." (the turn started on its interim, over the agent).
    { at: 186_700, vad: 'vad.start' },
    { at: 186_881, interim: 'No.' },
    { at: 187_790, vad: 'vad.stop' },
    { at: 187_891, interim: 'No. Have there' },
    { at: 187_893, agent: 'stop' },
    { at: 188_192, final: SAID7.turn21 },
    { at: 189_690, vad: 'vad.start' },
    { at: 190_303, interim: 'Have there' },
    // Modelled: a pause after "any-" (its final came 200 ms after the first interim, as Scribe
    // answers a commit) and the caller's voice again before "Crime".
    { at: 190_150, vad: 'vad.stop' },
    { at: 190_503, final: SAID7.turn22a },
    { at: 191_200, vad: 'vad.start' },
    { at: 191_700, interim: 'Crime, intr' },
    { at: 192_507, interim: 'Crime incidents reported in these' },
    { at: 192_490, vad: 'vad.stop' },
    { at: 192_813, final: SAID7.turn22b },
  ];
}

/**
 * Turns 24–25: "Okay, so yeah, I think, uh, Zagreb is one place and also talk to me about- Okay ...
 * uh, what happens-" (rule hold, 2297 ms at 220.167 s; the LLM wrote "Sorry, could you say that
 * again?"), then "Berlin, Berlin," 364 ms later and "In Berlin on New Year's Eve?" (rule unfinished,
 * 846 ms). The agent's last line ("…take ordinary city precautions.") stopped at 211.091 s.
 */
export function call7WhatHappens(): Step[] {
  return [
    { at: 196_274, agent: 'start' },
    { at: 211_091, agent: 'stop' },
    // turn-24: the VAD opened it.
    { at: 213_350, vad: 'vad.start' },
    { at: 214_802, interim: 'Okay sir,' },
    { at: 215_706, interim: 'Okay, so, yeah, I think,' },
    { at: 216_609, interim: 'Okay, so yeah, I think, uh, Zagreb is' },
    // Modelled: a pause before "…to me about-" (its final came 342 ms after the last interim, as
    // Scribe answers a commit), and the caller's voice again before the measured VAD stop.
    { at: 217_600, vad: 'vad.stop' },
    { at: 217_616, interim: 'Okay, so yeah, I think, uh, Zagreb is one place and also talk' },
    { at: 217_800, vad: 'vad.start' },
    { at: 217_958, final: SAID7.turn24a },
    { at: 218_070, vad: 'vad.stop' },
    // No VAD run behind these words: the VAD missed them.
    { at: 219_464, final: SAID7.turn24b },
    // turn-25 started on its first interim; its VAD run (stopped 394 ms before its final) is
    // modelled as starting just after it.
    { at: 220_531, interim: 'Berlin, Berlin,' },
    { at: 220_540, vad: 'vad.start' },
    { at: 220_770, vad: 'vad.stop' },
    { at: 221_164, final: SAID7.turn25 },
  ];
}
