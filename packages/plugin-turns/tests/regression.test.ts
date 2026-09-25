import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import {
  classifyConfirmation,
  type SpeechCapabilities,
  type TurnDecision,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

function fixture(
  overrides: Record<string, unknown> = {},
  mode: 'faq' | 'agent' = 'faq',
  vad = false,
  stt?: SpeechCapabilities,
) {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const controller = createTurnDetector(overrides).create({
    clock,
    vad,
    language: 'en-US',
    mode,
    ...(stt ? { stt } : {}),
  });
  controller.on((decision) => decisions.push(decision));
  let segment = 0;
  let revision = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (
    text: string,
    stability: 'interim' | 'final' = 'final',
    segmentId = `s${++segment}`,
  ) =>
    send({
      type: 'stt',
      event: { type: 'transcript', segment: { segmentId, revision: ++revision, text, stability } },
    });
  const say = (text: string) => {
    transcript(text);
    send({ type: 'stt', event: { type: 'end-of-turn' } });
  };
  const speech = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'speech' ? [d.input.text] : [],
    );
  const digits = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'dtmf' ? [d.input.digits] : [],
    );
  return { clock, decisions, controller, send, transcript, say, speech, digits };
}

describe('turn regressions', () => {
  const speechSignals: SpeechCapabilities = {
    languages: ['en-US'],
    interim: true,
    wordTimestamps: false,
    forceEndpoint: true,
    turnSignals: ['speech-start', 'speech-end', 'end-of-turn'],
  };
  it('accepts a silent-bot answer to Say yes', () => {
    const f = fixture();
    f.say('yes');
    expect(f.speech()).toEqual(['yes']);
  });
  it('does not interrupt or aggregate yes during an ordinary response', () => {
    const f = fixture();
    f.send({ type: 'bot.started', epoch: 1, kind: 'response' });
    f.say('yes');
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'response' });
    expect(f.speech()).toEqual([]);
    expect(f.decisions.some((d) => d.type === 'interrupt')).toBe(false);
  });
  it('accepts identical consecutive answers as distinct turns', () => {
    const f = fixture();
    f.say('yes');
    f.say('yes');
    expect(f.speech()).toEqual(['yes', 'yes']);
  });
  it('joins split finals and keeps each segment once', () => {
    const f = fixture();
    f.transcript('my number is', 'final', 'a');
    f.transcript('my number is', 'final', 'a');
    f.transcript('98 45', 'final', 'b');
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    expect(f.speech()).toEqual(['my number is 98 45']);
  });
  it('closes on utterance-end without end-of-turn', () => {
    const f = fixture();
    f.transcript('opening hours');
    f.send({ type: 'stt', event: { type: 'utterance-end' } });
    expect(f.speech()).toEqual(['opening hours']);
  });
  it('barge-in reevaluates the third interim', () => {
    const f = fixture();
    f.send({ type: 'bot.started', epoch: 1, kind: 'response' });
    f.transcript('yeah', 'interim', 'a');
    f.transcript('ok', 'interim', 'a');
    expect(f.decisions.some((d) => d.type === 'interrupt')).toBe(false);
    f.transcript('please stop now', 'interim', 'a');
    expect(f.decisions).toContainEqual({ type: 'interrupt', reason: 'transcript' });
  });
  it('counts Devanagari as a word when the bot is silent', () => {
    const f = fixture();
    f.say('हाँ');
    expect(f.speech()).toEqual(['हाँ']);
  });
  it('collects DTMF until #', () => {
    const f = fixture();
    for (const digit of '123#') f.send({ type: 'dtmf', digit });
    expect(f.digits()).toEqual(['123']);
  });
  it('flushes DTMF after a two-second gap', () => {
    const f = fixture();
    f.send({ type: 'dtmf', digit: '1' });
    f.clock.advance(2000);
    f.send({ type: 'dtmf', digit: '2' });
    f.clock.advance(2000);
    expect(f.digits()).toEqual(['1', '2']);
  });
  it('emits an idle retry, then final idle', () => {
    const f = fixture();
    f.send({ type: 'bot.started', epoch: 1 });
    f.send({ type: 'bot.stopped', epoch: 1 });
    f.clock.advance(10000);
    f.send({ type: 'bot.started', epoch: 2 });
    f.send({ type: 'bot.stopped', epoch: 2 });
    f.clock.advance(10000);
    expect(f.decisions.filter((d) => d.type === 'idle')).toEqual([
      { type: 'idle', retry: 1, final: false, prompt: 'Are you still there?' },
      { type: 'idle', retry: 1, final: true },
    ]);
  });
  it('buffers yes during a confirmation prompt and releases only on bot.stopped', () => {
    const f = fixture({}, 'agent');
    f.send({ type: 'confirmation.pending' });
    f.send({ type: 'bot.started', epoch: 1, kind: 'confirmation' });
    f.say('yes');
    expect(f.speech()).toEqual([]);
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'confirmation' });
    expect(f.speech()).toEqual(['yes']);
  });
  it('preserves NO precedence during a confirmation prompt', () => {
    const f = fixture({}, 'agent');
    f.send({ type: 'confirmation.pending' });
    f.send({ type: 'bot.started', epoch: 1, kind: 'confirmation' });
    f.say('yes no that is not correct');
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'confirmation' });
    expect(f.speech()).toEqual(['yes no that is not correct']);
    expect(classifyConfirmation(f.speech()[0]!)).toBe('no');
  });
  it('discards unclear speech during a confirmation prompt', () => {
    const f = fixture({}, 'agent');
    f.send({ type: 'confirmation.pending' });
    f.send({ type: 'bot.started', epoch: 1, kind: 'confirmation' });
    f.say('hello');
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'confirmation' });
    expect(f.speech()).toEqual([]);
    expect(f.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'turn.reset', reason: 'muted' })]),
    );
  });
  it('keeps haan during a normal response with a confirmation pending', () => {
    const f = fixture({}, 'agent');
    f.send({ type: 'confirmation.pending' });
    f.send({ type: 'bot.started', epoch: 1, kind: 'response' });
    f.say('haan');
    expect(f.speech()).toEqual([]);
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'response' });
    expect(f.speech()).toEqual(['haan']);
  });
  it('discards speech during tools but permits DTMF', () => {
    const f = fixture({}, 'agent');
    f.send({ type: 'tool.started' });
    f.say('hello there');
    f.send({ type: 'dtmf', digit: '1' });
    f.send({ type: 'dtmf', digit: '#' });
    expect(f.speech()).toEqual([]);
    expect(f.digits()).toEqual(['1']);
  });
  it('does not end a provider-signalled turn before speech-end', () => {
    const f = fixture({}, 'faq', false, speechSignals);
    f.send({ type: 'stt', event: { type: 'speech-start' } });
    f.transcript('hello there');
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    expect(f.speech()).toEqual([]);
    f.send({ type: 'stt', event: { type: 'speech-end' } });
    expect(f.speech()).toEqual(['hello there']);
  });
  it('waits for both VAD timers despite an immediate provider end signal', () => {
    const f = fixture({}, 'faq', true);
    f.send({ type: 'vad.start' });
    f.transcript('hello there');
    f.send({ type: 'vad.stop' });
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    expect(f.speech()).toEqual([]);
    f.clock.advance(599);
    expect(f.speech()).toEqual([]);
    f.clock.advance(1);
    expect(f.speech()).toEqual(['hello there']);
  });
  it('requests force-endpoint at vad.stop when no transcript has arrived', () => {
    const f = fixture({}, 'faq', true);
    f.send({ type: 'vad.start' });
    f.send({ type: 'vad.stop' });
    expect(f.decisions.filter((d) => d.type === 'force-endpoint')).toHaveLength(1);
    f.clock.advance(700);
    expect(f.decisions.filter((d) => d.type === 'force-endpoint')).toHaveLength(1);
  });
  it('does not force an already-finalized segment on vad.stop', () => {
    const f = fixture({}, 'faq', true);
    f.send({ type: 'vad.start' });
    f.transcript('hello there');
    f.send({ type: 'vad.stop' });
    expect(f.decisions.filter((d) => d.type === 'force-endpoint')).toHaveLength(0);
    f.clock.advance(1500);
    expect(f.decisions.filter((d) => d.type === 'force-endpoint')).toHaveLength(0);
  });
  it('holds a turn when STT still reports speaking even after VAD goes quiet', () => {
    const f = fixture({}, 'faq', true, speechSignals);
    f.send({ type: 'vad.start' });
    f.send({ type: 'stt', event: { type: 'speech-start' } });
    f.transcript('hello there');
    f.send({ type: 'vad.stop' });
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    f.clock.advance(1500);
    expect(f.speech()).toEqual([]);
    f.send({ type: 'stt', event: { type: 'speech-end' } });
    expect(f.speech()).toEqual(['hello there']);
  });
  it('does not arm idle while provider or VAD speech continues after bot.stopped', () => {
    for (const vad of [false, true]) {
      const f = fixture({}, 'faq', vad, speechSignals);
      f.send({ type: 'bot.started', epoch: 1 });
      if (vad) f.send({ type: 'vad.start' });
      else f.send({ type: 'stt', event: { type: 'speech-start' } });
      f.send({ type: 'bot.stopped', epoch: 1 });
      f.clock.advance(10000);
      expect(f.decisions.filter((d) => d.type === 'idle')).toEqual([]);
    }
  });
  it('does not mute an open turn on tool.started when during-tools is absent', () => {
    const f = fixture({ mute: ['during-confirmation'] }, 'agent');
    f.transcript('please', 'interim', 'a');
    f.send({ type: 'tool.started' });
    f.transcript('please help', 'final', 'a');
    f.send({ type: 'stt', event: { type: 'end-of-turn' } });
    expect(f.speech()).toEqual(['please help']);
    expect(f.decisions.some((d) => d.type === 'turn.reset' && d.reason === 'muted')).toBe(false);
  });
  it('does not interrupt a confirmation prompt on DTMF', () => {
    const f = fixture({}, 'agent');
    f.send({ type: 'bot.started', epoch: 1, kind: 'confirmation' });
    f.send({ type: 'dtmf', digit: '1' });
    f.send({ type: 'dtmf', digit: '#' });
    expect(f.decisions.some((d) => d.type === 'interrupt')).toBe(false);
    expect(f.digits()).toEqual(['1']);
  });
});
