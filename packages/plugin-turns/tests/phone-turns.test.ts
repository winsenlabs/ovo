import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import {
  isBackchannel,
  TurnConfigSchema,
  type SpeechCapabilities,
  type TurnDecision,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createTurnDetector, DetectorConfigSchema, PHONE_TURN_CONFIG } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** Scribe with commit_strategy=manual, as on the live CreditMantri calls. */
const scribe: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

function fixture(row: Record<string, unknown> = {}, { vad = true } = {}) {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const controller = createTurnDetector(row).create({
    clock,
    vad,
    language: 'en-IN',
    mode: 'agent',
    stt: scribe,
  });
  controller.on((decision) => decisions.push(decision));
  let segment = 0;
  let revision = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final', id = `s${segment}`) =>
    send({
      type: 'stt',
      event: {
        type: 'transcript',
        segment: { segmentId: id, revision: ++revision, text, stability },
      },
    });
  const forced = () => decisions.filter((d) => d.type === 'force-endpoint').length;
  /**
   * VAD speech of `ms`, the interim growing a word every 300 ms as Scribe's does, then the VAD
   * stop. Returns the milliseconds from the stop to the force-endpoint.
   */
  const speak = (ms: number, interim: string): number => {
    segment++;
    send({ type: 'vad.start' });
    const words = interim.split(' ');
    for (let at = 0; at < ms; at += 300) {
      const shown = Math.max(1, Math.round((words.length * (at + 300)) / ms));
      transcript(words.slice(0, shown).join(' '), 'interim');
      clock.advance(Math.min(300, ms - at));
    }
    send({ type: 'vad.stop' });
    const before = forced();
    let waited = 0;
    while (forced() === before && waited < 5000) {
      clock.advance(10);
      waited += 10;
    }
    return waited;
  };
  /** A caller utterance ending in the forced final, 350 ms after the commit as on the live calls. */
  const utter = (ms: number, interim: string, final: string) => {
    speak(ms, interim);
    clock.advance(350);
    transcript(final, 'final');
  };
  const of = <T extends TurnDecision['type']>(type: T) =>
    decisions.filter((d): d is Extract<TurnDecision, { type: T }> => d.type === type);
  const turns = () =>
    of('turn.stopped').flatMap((d) => (d.input.kind === 'speech' ? [d.input.text] : []));
  let greeted = false;
  const speaking = (question = false) => {
    // Mid-call speech: the opening has already played (N8 protects that; see opening.test.ts).
    if (!greeted) {
      greeted = true;
      send({ type: 'bot.started', epoch: 0, kind: 'response' });
      send({ type: 'bot.stopped', epoch: 0, kind: 'response' });
    }
    send({ type: 'bot.started', epoch: 1, kind: 'response', ...(question ? { question } : {}) });
  };
  const silent = () => send({ type: 'bot.stopped', epoch: 1, kind: 'response' });
  return { clock, decisions, send, transcript, speak, utter, forced, of, turns, speaking, silent };
}

/** Milliseconds from the VAD stop to the force-endpoint. */
const commitWait = (ms: number, interim: string) => fixture().speak(ms, interim);

describe('P2: turns no longer end mid-sentence', () => {
  it('short answers keep the 250 ms commit; long sentences wait ~450 ms', () => {
    // Jev and rules turns ("haan", "kal") lose nothing; the VAD's own 200 ms comes first.
    expect(commitWait(600, 'haan ji')).toBe(50);
    expect(commitWait(1100, 'kal subah')).toBe(50);
    // Call B 13:06:32: a 3 s sentence was committed 250 ms into a pause and answered as a fragment.
    expect(commitWait(3000, "You're lucky. What's the product? You didn't go there")).toBe(250);
  });

  it('an interim broken off mid-word waits the long silence however short', () => {
    // Call B 13:06:37 "Tell me, who-", 13:07:55 "Do I need to identify-".
    expect(commitWait(250, 'Tell me, who-')).toBe(250);
  });

  it("a final ending in '-' waits for the caller, who goes on: one turn, not two", () => {
    const f = fixture();
    // Call B 13:06:32.314 "…tell me for-" stopped; the caller went on 42 ms later.
    f.utter(3000, 'No, what is the product that you just', "You didn't go there and tell me for-");
    expect(f.turns()).toEqual([]);
    f.clock.advance(300);
    f.utter(700, 'one', 'One minute.');
    f.clock.advance(1000);
    expect(f.turns()).toEqual(["You didn't go there and tell me for- One minute."]);
  });

  it('a broken-off final with no more speech ends after cutoffHoldMs', () => {
    const f = fixture();
    f.utter(1500, 'Do you know', 'Do you know any-');
    f.clock.advance(699);
    expect(f.turns()).toEqual([]);
    f.clock.advance(1);
    expect(f.turns()).toEqual(['Do you know any-']);
  });

  it('a complete final ends the turn at once, and cutoffHoldMs 0 turns the hold off', () => {
    const f = fixture();
    f.utter(600, 'One minute', 'One minute.');
    expect(f.turns()).toEqual(['One minute.']);
    const off = fixture({ cutoffHoldMs: 0 });
    off.utter(1500, 'Promoter of', 'Promoter of CreditMantri is a...');
    expect(off.turns()).toEqual(['Promoter of CreditMantri is a...']);
  });
});

describe('background talkers and noise', () => {
  /** A first caller turn with VAD speech, so the VAD is known to hear this caller. */
  const heard = (f: ReturnType<typeof fixture>) => {
    f.utter(600, 'haan', 'Haan, bolo.');
    f.clock.advance(2000);
  };

  it('words over the agent with no VAD speech behind them neither barge in nor become a turn', () => {
    const f = fixture();
    heard(f);
    f.speaking();
    f.transcript('who is that on the phone', 'interim', 'tv');
    f.transcript('who is that on the phone', 'final', 'tv');
    f.clock.advance(6000);
    expect(f.of('interrupt')).toEqual([]);
    expect(f.turns()).toEqual(['Haan, bolo.']);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel']);
  });

  it('the caller barging in, VAD and words together, still interrupts at once', () => {
    const f = fixture();
    heard(f);
    f.speaking();
    f.send({ type: 'vad.start' });
    f.clock.advance(300);
    f.transcript('wait wait listen', 'interim', 'c');
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('words that arrive before the VAD catches up barge in when it does', () => {
    const f = fixture();
    heard(f);
    f.speaking();
    f.transcript('no no stop', 'interim', 'c');
    expect(f.of('interrupt')).toEqual([]);
    f.send({ type: 'vad.start' });
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('until the VAD has heard the caller once, transcripts barge in as before', () => {
    const f = fixture();
    f.speaking();
    f.transcript('please stop now', 'interim', 'a');
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('speechEvidence.turns also drops room talk in silence; the caller still starts turns', () => {
    const f = fixture({ speechEvidence: { turns: true } });
    heard(f);
    f.transcript('arre sun na', 'interim', 'room');
    f.transcript('arre sun na', 'final', 'room');
    f.clock.advance(6000);
    expect(f.of('turn.started').length).toBe(1);
    f.utter(600, 'kal', 'Kal subah.');
    expect(f.turns()).toEqual(['Haan, bolo.', 'Kal subah.']);
  });

  it('audio-event tags are not words: a tag alone is nothing, and tags never barge in', () => {
    const f = fixture({}, { vad: false });
    f.transcript('(beep)', 'final', 'b');
    f.transcript('[background noise]', 'final', 'n');
    expect(f.of('turn.started')).toEqual([]);
    f.speaking();
    f.transcript('(phone ringing) haan ji', 'interim', 'h');
    f.transcript('<noise> please stop now', 'interim', 'p');
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
    expect(f.of('turn.partial').at(-1)?.text).toBe('haan ji please stop now');
  });

  it('a VAD-only turn (a thump, a cough) is dropped soon after its commit, not after 5 s', () => {
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.clock.advance(400);
    f.send({ type: 'vad.stop' });
    // 50 ms commit + 600 ms ceiling + 1000 ms grace.
    f.clock.advance(1649);
    expect(f.of('turn.reset')).toEqual([]);
    f.clock.advance(1);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel']);
  });

  it('a late forced final inside the grace is still the turn', () => {
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.clock.advance(400);
    f.send({ type: 'vad.stop' });
    f.clock.advance(1200);
    f.transcript('Haan.', 'final', 'late');
    f.clock.advance(1000);
    expect(f.turns()).toEqual(['Haan.']);
  });

  it('a key press drops a turn the VAD opened on its tone', () => {
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.send({ type: 'dtmf', digit: '5' });
    f.clock.advance(3000);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel']);
    expect(
      f.of('turn.stopped').map((d) => (d.input.kind === 'dtmf' ? d.input.digits : '')),
    ).toEqual(['5']);
  });
});

describe('Indian English and Hinglish backchannels', () => {
  const config = TurnConfigSchema.parse({});

  it.each([
    'ok sir',
    'Yes, madam.',
    "Yes ma'am",
    'haan ji sir',
    'ji sir',
    'theek hai madam',
    'achha ji',
    'hmm hmm',
    'Mm.',
    'hanji',
    'samajh gaya',
    'boliye',
    'हाँ जी सर',
    'जी हां',
    'சரி',
    'aama',
    'go ahead',
    'correct correct',
  ])('%s only acknowledges the agent', (text) => {
    expect(isBackchannel(text, 'en-IN', config)).toBe(true);
    // By the list alone, as over a filler: one word is already under minWordsWhileBotSpeaking.
    expect(isBackchannel(text, 'en-IN', { ...config, minWordsWhileBotSpeaking: 0 })).toBe(true);
  });

  it.each(['madam madam', 'sir sir please', 'no sir', 'sir I already paid', 'हाँ पर सर सुनिए'])(
    '%s is the caller asking to be heard',
    (text) => {
      expect(isBackchannel(text, 'en-IN', config)).toBe(false);
    },
  );

  it('call B 13:05:59: "Yes, sir." over the greeting question answers it, no barge-in', () => {
    const f = fixture();
    f.speaking(true);
    f.utter(500, 'Yes, sir.', 'Yes, sir.');
    expect(f.of('interrupt')).toEqual([]);
    expect(f.turns()).toEqual([]);
    f.silent();
    expect(f.turns()).toEqual(['Yes, sir.']);
  });

  it('keeps minWordsWhileBotSpeaking at 2 and the default list within its 100 entries', () => {
    expect(config.minWordsWhileBotSpeaking).toBe(2);
    expect(config.backchannels.length).toBeLessThanOrEqual(100);
  });
});

it('PHONE_TURN_CONFIG is the documented phone row: the defaults', () => {
  expect(PHONE_TURN_CONFIG).toEqual(DetectorConfigSchema.parse({}));
});
