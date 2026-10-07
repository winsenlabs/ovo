import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import {
  isBackchannel,
  turnDetectorLines,
  TurnConfigSchema,
  type TurnDecision,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

function fixture(overrides: Record<string, unknown> = {}, language = 'en-IN') {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const controller = createTurnDetector(overrides).create({
    clock,
    vad: false,
    language,
    mode: 'agent',
  });
  controller.on((decision) => decisions.push(decision));
  let segment = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (
    text: string,
    stability: 'interim' | 'final' = 'final',
    id = `s${++segment}`,
  ) =>
    send({
      type: 'stt',
      event: { type: 'transcript', segment: { segmentId: id, revision: 1, text, stability } },
    });
  const say = (text: string) => {
    transcript(text);
    send({ type: 'stt', event: { type: 'end-of-turn' } });
  };
  // Mid-call speech: the opening has already played (N8 protects that; see opening.test.ts).
  send({ type: 'bot.started', epoch: 0, kind: 'response' });
  send({ type: 'bot.stopped', epoch: 0, kind: 'response' });
  const speaking = (question = false) =>
    send({ type: 'bot.started', epoch: 1, kind: 'response', ...(question ? { question } : {}) });
  const silent = () => send({ type: 'bot.stopped', epoch: 1, kind: 'response' });
  const of = <T extends TurnDecision['type']>(type: T) =>
    decisions.filter((d): d is Extract<TurnDecision, { type: T }> => d.type === type);
  const turns = () =>
    of('turn.stopped').flatMap((d) => (d.input.kind === 'speech' ? [d.input.text] : []));
  return { clock, decisions, send, transcript, say, speaking, silent, of, turns };
}

describe('backchannels while the agent speaks (AGT-9)', () => {
  it.each([
    'haan',
    'haan ji',
    'theek hai',
    'achha',
    'acha theek hai',
    'haan haan',
    'ok ok',
    'hmm okay',
    'हाँ जी',
    'ठीक है',
    'Haan, ji.',
  ])('%s neither barges in nor starts a turn', (text) => {
    const f = fixture();
    f.speaking();
    f.say(text);
    f.silent();
    expect(f.of('interrupt')).toEqual([]);
    expect(f.turns()).toEqual([]);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel']);
  });

  it('still lets a real utterance barge in, even one that starts with a backchannel', () => {
    const f = fixture();
    f.speaking();
    f.say('haan but I already paid');
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
    expect(f.turns()).toEqual(['haan but I already paid']);
  });

  it('honours a configured word list and minimum word count', () => {
    const custom = fixture({ backchannels: ['bas'], minWordsWhileBotSpeaking: 3 });
    custom.speaking();
    custom.say('bas bas bas');
    custom.say('one moment');
    expect(custom.of('interrupt')).toEqual([]);
    expect(custom.turns()).toEqual([]);
    // 'haan haan haan' is no longer a backchannel word, and has three words.
    custom.say('haan haan haan');
    expect(custom.of('interrupt')).toHaveLength(1);
    expect(custom.turns()).toEqual(['haan haan haan']);
  });

  it('lets any word barge in when the agent turns backchannels off', () => {
    const f = fixture({ backchannelsEnabled: false });
    f.speaking();
    f.say('haan');
    expect(f.of('interrupt')).toHaveLength(1);
    expect(f.turns()).toEqual(['haan']);
  });

  it('answers a short reply to a question once the agent stops, without cutting it off', () => {
    const f = fixture();
    f.speaking(true);
    f.say('haan');
    expect(f.of('interrupt')).toEqual([]);
    expect(f.turns()).toEqual([]);
    f.silent();
    expect(f.turns()).toEqual(['haan']);
  });

  it('treats a later question line in the same interval as a question', () => {
    const f = fixture();
    f.speaking();
    f.speaking(true);
    f.say('yes');
    f.silent();
    expect(f.turns()).toEqual(['yes']);
  });

  it('matches runs of backchannels, but not long utterances made of them', () => {
    const config = TurnConfigSchema.parse({});
    expect(isBackchannel('ok theek hai haan ji', 'en-IN', config)).toBe(true);
    expect(isBackchannel('haan haan haan haan haan haan haan', 'en-IN', config)).toBe(false);
    expect(isBackchannel('yes please', 'en-IN', config)).toBe(false);
    expect(isBackchannel('ji', 'en-IN', { ...config, minWordsWhileBotSpeaking: 0 })).toBe(true);
    expect(isBackchannel('haan', 'en-IN', { ...config, backchannelsEnabled: false })).toBe(false);
  });
});

describe('partial transcripts for speculation (LAT-4)', () => {
  it('announces each new revision of an answerable utterance, stable once final', () => {
    const f = fixture();
    f.transcript('I want', 'interim', 'a');
    f.transcript('I want', 'interim', 'a');
    f.transcript('I want to pay', 'final', 'a');
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    expect(f.of('turn.partial')).toEqual([
      { type: 'turn.partial', turnId: 'turn-1', text: 'I want', stable: false },
      { type: 'turn.partial', turnId: 'turn-1', text: 'I want to pay', stable: true },
    ]);
    expect(f.turns()).toEqual(['I want to pay']);
  });

  it('never announces a backchannel over the agent, and announces a barge-in', () => {
    const f = fixture();
    f.speaking();
    f.say('haan');
    expect(f.of('turn.partial')).toEqual([]);
    f.transcript('wait, I have', 'interim', 'b');
    expect(f.of('turn.partial').map((d) => d.text)).toEqual(['wait, I have']);
  });
});

describe('filler offers (LAT-6)', () => {
  it('offers none by default', () => {
    const f = fixture();
    f.say('what is my balance');
    expect(f.of('turn.stopped')[0]).not.toHaveProperty('filler');
  });

  it('offers the configured lines in rotation, one per caller turn', () => {
    const f = fixture({ filler: { lines: ['One moment.', 'Let me check.'], afterMs: 500 } });
    for (const text of ['first question', 'second question', 'third question']) f.say(text);
    expect(f.of('turn.stopped').map((d) => d.filler)).toEqual([
      { text: 'One moment.', afterMs: 500 },
      { text: 'Let me check.', afterMs: 500 },
      { text: 'One moment.', afterMs: 500 },
    ]);
  });
});

describe('speech over a filler line (LAT-6 with AGT-9)', () => {
  const filler = () =>
    ({ type: 'bot.started', epoch: 1, kind: 'acknowledgment', filler: true }) as const;

  it('takes a one-word continuation as a turn, as in silence', () => {
    const f = fixture();
    f.send(filler());
    f.say('Tejas');
    expect(f.of('turn.reset')).toEqual([]);
    expect(f.turns()).toEqual(['Tejas']);
    expect(f.of('turn.partial').map((d) => d.text)).toEqual(['Tejas']);
  });

  it('still drops a backchannel that acknowledges the filler', () => {
    const f = fixture();
    f.send(filler());
    f.say('ok');
    f.say('haan ji');
    expect(f.turns()).toEqual([]);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel', 'backchannel']);
  });

  it('goes back to backchannel rules once the reply itself is audible', () => {
    const f = fixture();
    f.send(filler());
    f.send({ type: 'bot.started', epoch: 1, kind: 'response' });
    f.say('Tejas');
    expect(f.turns()).toEqual([]);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel']);
  });
});

describe('turnDetectorLines', () => {
  it('reads idle prompts and filler lines past detector-specific fields', () => {
    expect(
      turnDetectorLines({
        strategy: 'commit',
        commit: { silenceMs: 50 },
        filler: { lines: ['One moment.'], afterMs: 500 },
      }),
    ).toEqual({ idle: ['Are you still there?'], filler: ['One moment.'] });
    expect(turnDetectorLines({ idle: null })).toEqual({ idle: [], filler: [] });
    expect(turnDetectorLines({ filler: { lines: [] } })).toEqual({ idle: [], filler: [] });
  });
});
