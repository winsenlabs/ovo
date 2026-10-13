import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { LIVE, MAYA, RECOMMENDED, replay } from './replay.ts';

describe('Wave 8 latency fix 1: complete turns end on the short silence', () => {
  // Call 6e1a4e3a: turn, VAD speech (turn-2 measured, ~250 ms a word otherwise), final, live
  // endpointMs, Scribe's commit-to-final latency (vad_stop_wait less Maya's 450 ms) and the
  // interims a long utterance had (turn-2's first interim landed 692 ms after its VAD stop).
  const normal: [string, number, string, number, number, string[]][] = [
    ['turn-2', 1030, 'Yeah, yeah, hi, my friend.', 1020, 369, []],
    ['turn-7', 1000, 'Who are the Nazis?', 985, 335, []],
    ['turn-16', 900, 'Sometime during Christmas.', 1014, 363, []],
    [
      'turn-4',
      3750,
      "I'm planning to go to Zagreb in Croatia. What do you know about this place?",
      1006,
      356,
      [
        "I'm planning",
        "I'm planning to go to Zagreb",
        "I'm planning to go to Zagreb in Croatia. What",
      ],
    ],
    [
      'turn-15',
      2500,
      'No. Can you check for flights from Chennai to Frankfurt?',
      1009,
      358,
      ['No. Can you', 'No. Can you check for flights'],
    ],
  ];

  it.each(normal)(
    '%s: the replay matches the live endpoint',
    (_, ms, text, live, lat, interims) => {
      const f = replay(new FakeClock(), LIVE);
      f.utter(ms, text, lat, interims);
      expect(f.turns.map((t) => t.text)).toEqual([text]);
      expect(Math.abs(f.turns[0]!.endpointMs - live)).toBeLessThanOrEqual(1);
      expect(f.turns[0]!.reason).toBe(ms >= 1200 ? 'long' : 'silence');
    },
  );

  it.each(normal)('%s: the recommended row saves 450 ms', (_, ms, text, live, lat, interims) => {
    const f = replay(new FakeClock(), RECOMMENDED);
    f.utter(ms, text, lat, interims);
    // Wave 8 committed a short utterance 50 ms after the VAD stop and a long one with no closing
    // interim after Wave 6's 250 ms (P2). Wave 10 commits each as the VAD stops, and its final,
    // which reads complete, ends it at once: 450 ms sooner than live's 450 ms commit.
    const saved = 450;
    expect(f.turns.map((t) => t.text)).toEqual([text]);
    expect(Math.abs(f.turns[0]!.endpointMs - (live - saved))).toBeLessThanOrEqual(1);
  });

  it("with Maya's 450 ms kept, a complete interim at the stop commits at once: 450 ms saved", () => {
    const f = replay(new FakeClock(), MAYA);
    f.commits('Sometime during Christmas.', 363);
    f.send({ type: 'vad.start' });
    f.clock.advance(800);
    f.interim('Sometime during Christmas.');
    f.clock.advance(100);
    f.send({ type: 'vad.stop' });
    f.clock.advance(5000);
    expect(f.turns).toMatchObject([{ endpointMs: 563, reason: 'complete' }]);
  });

  it('after a question, a short reply with no closing punctuation is complete: 450 ms saved', () => {
    const f = replay(new FakeClock(), MAYA);
    f.agentStarts(true);
    f.clock.advance(3000);
    f.agentStops();
    f.commits('Zagreb.', 360);
    f.send({ type: 'vad.start' });
    f.clock.advance(500);
    f.interim('Zagreb');
    f.clock.advance(100);
    f.send({ type: 'vad.stop' });
    f.clock.advance(5000);
    expect(f.turns).toMatchObject([{ text: 'Zagreb.', endpointMs: 560, reason: 'complete' }]);
  });

  it('a final that trails off still waits for the caller: one turn (Wave 6 P2 kept)', () => {
    const f = replay(new FakeClock(), RECOMMENDED);
    // Call B 13:06:32: "…tell me for-" committed into a pause; the caller went on.
    f.commits("You didn't go there and tell me for-", 360);
    f.send({ type: 'vad.start' });
    f.clock.advance(3000);
    f.send({ type: 'vad.stop' });
    f.clock.advance(650);
    f.utter(600, 'One minute.', 350);
    expect(f.turns.map((t) => t.text)).toEqual([
      "You didn't go there and tell me for- One minute.",
    ]);
  });
});

describe('call-3 #5: a number, date or amount broken off is one turn', () => {
  it('turn-17 "…be back around the 1" + turn-18 "st." are one turn, "…the 1st."', () => {
    const f = replay(new FakeClock(), MAYA);
    const said = "Yeah. So we'd like to leave on the 20th and be back around the 1";
    // Live: its final came 474 ms after the VAD stop (675 ms endpoint), and "st." 291 ms after
    // the turn ended, as a turn of its own that ran a web search. Wave 10: Scribe's answer comes as
    // measured, whenever the commit went out.
    const stopAt = f.clock.now() + 3200;
    f.commitsAt(said, stopAt + 474);
    f.send({ type: 'vad.start' });
    for (const interim of ["Yeah. So we'd like", "Yeah. So we'd like to leave on the 20th"]) {
      f.clock.advance(1000);
      f.interim(interim);
    }
    f.clock.advance(1000);
    f.interim(`${said.slice(0, -2)}`);
    f.clock.advance(200);
    f.send({ type: 'vad.stop' });
    f.clock.advance(474 + 291);
    f.final('st.');
    f.clock.advance(5000);
    expect(f.turns).toMatchObject([{ text: `${said}st.`, endpointMs: 965 }]);
  });

  it('with nothing more, the broken-off number ends after cutoffHoldMs', () => {
    const f = replay(new FakeClock(), MAYA);
    f.utter(1500, 'I will pay around 2', 350, ['I will pay']);
    expect(f.turns).toMatchObject([{ text: 'I will pay around 2', reason: 'hold' }]);
    expect(f.turns[0]!.endpointMs).toBe(200 + 450 + 350 + 700);
  });
});

describe('Wave 8 latency fix 2: one-word answers end at once', () => {
  // Words too short or soft to start the energy VAD (a -30 dBFS "yes" never does): no VAD stop,
  // so the live detector committed only on its 1.5 s stall. Live endpointMs and Scribe's latency;
  // Scribe answered three of these commits with no text, and the turn ended on the interim.
  it.each([
    ['6e1a4e3a turn-3', 'Hello?', 1892, 392, ''],
    ['6e1a4e3a turn-21', 'Yeah.', 1873, 373, ''],
    ['6e1a4e3a turn-22', 'Oh, my God.', 1868, 368, ''],
    ['f3363705 turn-6', 'Yes.', 1823, 323, 'Yes.'],
    ['f3363705 turn-8', 'Yes.', 1799, 299, 'Yes.'],
  ])('%s %s: %i ms live, 1250 ms sooner now', (_, text, live, latency, final) => {
    for (const [row, endpointMs, reason] of [
      [LIVE, live, 'stall'],
      [MAYA, live - 1250, 'answer'],
    ] as const) {
      const f = replay(new FakeClock(), row);
      f.agentStarts(true);
      f.clock.advance(2000);
      f.agentStops();
      f.clock.advance(400);
      f.commits(final, latency);
      f.interim(text);
      f.clock.advance(5000);
      expect(f.turns).toEqual([expect.objectContaining({ text, endpointMs, reason })]);
    }
  });

  it('said into a VAD the room holds open, it keeps the stall: the caller may go on', () => {
    const f = replay(new FakeClock(), MAYA);
    f.send({ type: 'vad.start' });
    f.clock.advance(2000);
    f.commits('Yeah.', 373);
    f.interim('Yeah.');
    f.clock.advance(5000);
    expect(f.turns).toMatchObject([{ text: 'Yeah.', endpointMs: 1873, reason: 'stall' }]);
  });

  // Review of Wave 8: the 250 ms answer stall ended turns the caller was still saying, as any
  // three words after a question, or into a VAD run the caller was in. Scribe's interims change
  // about once a second, so the stall fired before the rest of the reply landed.
  const question = (row: Record<string, unknown>) => {
    const f = replay(new FakeClock(), row);
    f.agentStarts(true);
    f.clock.advance(2000);
    f.agentStops();
    f.clock.advance(400);
    return f;
  };

  it.each([
    ['LIVE', LIVE],
    ['MAYA', MAYA],
  ])('%s: a café VAD held open by the room does not split "Two adults" from the rest', (_, row) => {
    const f = question(row);
    // The room holds the VAD open from the agent's stop; the caller starts 2 s into it.
    f.send({ type: 'vad.start' });
    f.clock.advance(2000);
    f.interim('Two adults');
    f.clock.advance(1000);
    f.interim('Two adults and one child');
    f.clock.advance(1000);
    expect(f.forced()).toBe(0);
    f.final('Two adults and one child, please.');
    f.clock.advance(5000);
    expect(f.turns.map((t) => t.text)).toEqual(['Two adults and one child, please.']);
  });

  it.each([
    ['LIVE', LIVE],
    ['MAYA', MAYA],
  ])('%s: a soft caller the VAD never hears is not committed after "My name is"', (_, row) => {
    const f = question(row);
    const said = 'My name is Tejas Sudarshan and I want to book a flight.';
    f.commits(said, 350);
    for (const interim of [
      'My name is',
      'My name is Tejas Sudarshan',
      'My name is Tejas Sudarshan and I want to',
    ]) {
      f.interim(interim);
      f.clock.advance(1000);
    }
    expect(f.forced()).toBe(0);
    f.interim(said);
    f.clock.advance(5000);
    expect(f.forced()).toBe(1);
    expect(f.turns.map((t) => t.text)).toEqual([said]);
  });

  it.each([
    ['LIVE', LIVE],
    ['MAYA', MAYA],
  ])('%s: "Yes." whose words came 1.9 s into the VAD run waits for the stop', (_, row) => {
    const f = question(row);
    const said = 'Yes, but can we go on Friday instead?';
    f.commits(said, 350);
    f.send({ type: 'vad.start' });
    f.clock.advance(1900);
    f.interim('Yes.');
    f.clock.advance(1000);
    f.interim(said);
    f.clock.advance(500);
    expect(f.forced()).toBe(0);
    f.send({ type: 'vad.stop' });
    f.clock.advance(5000);
    expect(f.turns.map((t) => t.text)).toEqual([said]);
  });

  it('a VAD run shorter than minSpeechMs commits once its words arrive', () => {
    const f = replay(new FakeClock(), MAYA);
    f.commits('Yes.', 330);
    f.send({ type: 'vad.start' });
    f.clock.advance(150);
    f.send({ type: 'vad.stop' });
    f.clock.advance(600);
    f.interim('Yes.');
    f.clock.advance(5000);
    // Committed as the interim lands (the stop's 50 ms is past): 1.5 s sooner than the stall.
    expect(f.turns).toMatchObject([{ text: 'Yes.', endpointMs: 1130, reason: 'complete' }]);
  });

  it('words long after such a run are new speech, not committed on arrival', () => {
    const f = replay(new FakeClock(), MAYA);
    // A cough over the agent opens no turn; 3 s later a caller the VAD does not hear starts.
    f.agentStarts();
    f.send({ type: 'vad.start' });
    f.clock.advance(150);
    f.send({ type: 'vad.stop' });
    f.clock.advance(1000);
    f.agentStops();
    f.clock.advance(2000);
    f.interim('I want to');
    f.clock.advance(1499);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
  });

  it('a short answer the VAD is still timing waits for its stop: no cut-off', () => {
    const f = replay(new FakeClock(), MAYA);
    f.utter(2000, 'Yes, I want to go to Rome.', 350, ['Yes.', 'Yes, I want to go']);
    expect(f.turns.map((t) => t.text)).toEqual(['Yes, I want to go to Rome.']);
  });
});
