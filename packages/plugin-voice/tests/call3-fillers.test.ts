import { describe, expect, it } from 'vitest';
import type { Behavior, TurnSpeculation } from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement, InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep, slowAgent } from '../../eval/src/replay-kit/index.ts';

/**
 * Call 6e1a4e3a (Maya, 2026-10-08, noisy café; /tmp/ovo/last-call-turns.json), times from each
 * reply starting (its turn decision), which is when the 1.5 s filler timer starts. TTS first byte
 * ~150 ms; a pre-rendered filler clip starts at once and plays ~0.8 s (an estimate: the log has no
 * line durations).
 */
const FILLER = { text: 'One moment.', afterMs: 1500 };
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
const CLIPS = [FILLER.text, ANNOUNCE.line!, ANNOUNCE.stillLine!];
const CLIP_MS = 800;
const TTS_MS = 150;

const search = (id = 'ws-1'): InferenceActivity => ({
  phase: 'started',
  tool: 'web_search',
  id,
  atMs: 0,
  signal: new AbortController().signal,
  announce: ANNOUNCE,
});

function setup(llmMs: number) {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs });
  const h = driverHarness(clock, agent.behavior, {
    ttsMs: TTS_MS,
    playMs: 3000,
    fillerPlayMs: CLIP_MS,
    fillers: CLIPS,
  });
  return { clock, agent, h };
}

/** Every filler line heard, and the silence before each, from the reply's start. */
function heard(audio: { text: string; atMs: number }[], t0: number) {
  return audio.map((line) => [line.text, line.atMs - t0] as const);
}

describe('call-3 #1: one filler line per turn, never stacked', () => {
  // Turn 4 ("Zagreb ... what do you know about this place?"): the search started 2641 ms in and
  // the first answer line was ready at 5790 ms. Live the caller heard "One moment." at 1.5 s, "Let
  // me look that up." at 2.64 s right behind it, and "Still checking, one moment." at 5.14 s.
  it('turn 4: the search line is not stacked on the generic filler', async () => {
    const { clock, h } = setup(5790);
    const t0 = await h.greet();
    h.caller('I am planning to go to Zagreb. What do you know about this place?', FILLER);
    await clock.advanceAsync(2641);
    h.driver.inferenceActivity(search());
    await clock.advanceAsync(10_000);
    const lines = heard(h.audio, t0);
    expect(lines).toEqual([
      [FILLER.text, 1500],
      ['Answer: I am planning to go to Zagreb. What do you know about this place?.', 5790 + TTS_MS],
    ]);
    // Three filler lines (two of them back to back) became one (Wave 9, D6: no "still checking"
    // after a filler line; call-3 #1 had left two, 2.8 s apart).
    expect(lines.filter(([text]) => CLIPS.includes(text))).toHaveLength(1);
  });

  // Turn 6 ("tell me more about Nuremberg"): live "One moment." at 1.5 s, "Let me look that up." at
  // 2.35 s (0.85 s later: straight after the clip), "Still checking" at 4.85 s, answer at 6.18 s.
  it('turn 6: the generic filler is the only line', async () => {
    const { clock, h } = setup(6030);
    const t0 = await h.greet();
    h.caller('Hmm, okay. So, tell me more about Nuremberg.', FILLER);
    await clock.advanceAsync(2349);
    h.driver.inferenceActivity(search());
    await clock.advanceAsync(10_000);
    expect(heard(h.audio, t0).map(([text]) => text)).toEqual([
      FILLER.text,
      'Answer: Hmm, okay. So, tell me more about Nuremberg..',
    ]);
  });

  // Turn 15 ("Can you check for flights from Chennai to Frankfurt?"): the search started before the
  // generic filler was due, so its line took the filler's place, as it still does.
  it('turn 15: a search before the filler is due says its own line instead', async () => {
    const { clock, h } = setup(4062);
    const t0 = await h.greet();
    h.caller('No. Can you check for flights from Chennai to Frankfurt?', FILLER);
    await clock.advanceAsync(1300);
    h.driver.inferenceActivity(search());
    await clock.advanceAsync(10_000);
    // Live "still checking" was queued 1.7 s after this line ended and cut by the answer before
    // any of it was heard; now it waits for 2.5 s of silence (4.6 s), after the answer.
    expect(heard(h.audio, t0)).toEqual([
      [ANNOUNCE.line, 1300],
      ['Answer: No. Can you check for flights from Chennai to Frankfurt?.', 4062 + TTS_MS],
    ]);
  });
});

/**
 * Turns 21 and 22: the caller said "Yeah." and heard only "One moment."; the reply searched (1853
 * ms) but, 3.9 s in and before its first token, the caller's "Oh, my God." superseded it. The merged
 * turn searched again and its answer came 4.88 s after that (first token), so the answer to turn 21
 * surfaced in turn 22. Here "Oh, my God." starts at 2.4 s and ends at 3.9 s, the search starts at
 * 2.6 s (while the caller speaks, so no search line: live there was none), and either reply takes
 * as long as turn 22's did.
 */
describe('call-3 #1: a searching reply is not thrown away for a brief remark', () => {
  const ANSWER_MS = 4880;

  function agent(clock: FakeClock) {
    const asked: string[] = [];
    const behavior: Behavior & TurnSpeculation = {
      respond: async () => '',
      async *respondStream(input, variables = {}) {
        if (variables.inputEvent === 'opening') {
          yield 'Hello, this is Maya.';
          return;
        }
        asked.push(input);
        await sleep(clock, input.split(' ').length <= 3 && asked.length > 1 ? 900 : ANSWER_MS);
        yield `Answer: ${input}`;
      },
    };
    return { behavior, asked };
  }

  async function replay(remark: string) {
    const clock = new FakeClock();
    const maya = agent(clock);
    const h = driverHarness(clock, maya.behavior, {
      ttsMs: TTS_MS,
      playMs: 1000,
      fillerPlayMs: CLIP_MS,
      fillers: CLIPS,
    });
    const t0 = await h.greet();
    h.turn.stopped('turn-21', 'Yeah.', FILLER);
    await clock.advanceAsync(2400);
    h.turn.vad('vad.start');
    h.turn.started('turn-22');
    await clock.advanceAsync(200);
    h.driver.inferenceActivity(search());
    await clock.advanceAsync(200);
    h.turn.partial('turn-22', remark);
    await clock.advanceAsync(1100);
    h.turn.vad('vad.stop');
    h.turn.stopped('turn-22', remark);
    await clock.advanceAsync(15_000);
    return { asked: maya.asked, lines: heard(h.audio, t0) };
  }

  it('answers turn 21 in turn 21, 3.9 s sooner, then the remark', async () => {
    const { asked, lines } = await replay('Oh, my God.');
    expect(asked).toEqual(['Yeah.', 'Oh, my God.']);
    // Before: the merged "Yeah. Oh, my God." started over at 3.9 s; its answer played at 8930 ms.
    expect(lines).toEqual([
      [FILLER.text, 1500],
      ['Answer: Yeah.', ANSWER_MS + TTS_MS],
      // The remark is answered once the answer has played (1 s here).
      ['Answer: Oh, my God.', ANSWER_MS + TTS_MS + 1000 + 900 + TTS_MS],
    ]);
  });

  it('still starts over for words that change the request', async () => {
    const { asked } = await replay('Actually, flights to Munich instead.');
    expect(asked).toEqual(['Yeah.', 'Yeah. Actually, flights to Munich instead.']);
  });
});
