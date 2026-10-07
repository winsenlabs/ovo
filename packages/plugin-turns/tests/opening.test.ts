import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { SpeechCapabilities, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { createTurnDetector, PHONE_TURN_CONFIG } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** Scribe with commit_strategy=manual, as on the live calls. */
const scribe: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

function fixture(row: Record<string, unknown> = {}, vad = true) {
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
  let revision = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final', id = 's1') =>
    send({
      type: 'stt',
      event: {
        type: 'transcript',
        segment: { segmentId: id, revision: ++revision, text, stability },
      },
    });
  const bot = (epoch: number, playing: boolean) =>
    send({ type: playing ? 'bot.started' : 'bot.stopped', epoch, kind: 'response' });
  const interrupts = () => decisions.filter((d) => d.type === 'interrupt');
  const turns = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'speech' ? [d.input.text] : [],
    );
  return { clock, send, transcript, bot, interrupts, turns };
}

describe('the opening is protected from a single stray interim (N8)', () => {
  it('Maya call b1fd8b51: a garbled interim 2.3 s into the greeting no longer cuts it', () => {
    const f = fixture();
    f.bot(1, true);
    f.clock.advance(2289);
    // The STT's first guess, revised 40 ms later into different words: never confirmed.
    f.transcript('Знаете, что?', 'interim');
    f.clock.advance(39);
    f.transcript('Нет, это всё.', 'final');
    f.clock.advance(3000);
    expect(f.interrupts()).toEqual([]);
    f.bot(1, false);
    // The words are not lost: the caller's turn is answered once the greeting has played.
    expect(f.turns()).toEqual(['Нет, это всё.']);
  });

  it('confirmed words barge in once the protected window has passed, not before', () => {
    const f = fixture();
    f.bot(1, true);
    f.clock.advance(300);
    f.send({ type: 'vad.start' });
    f.transcript('please', 'interim');
    f.clock.advance(300);
    f.transcript('please stop', 'interim');
    f.clock.advance(899);
    expect(f.interrupts()).toEqual([]);
    f.clock.advance(1);
    expect(f.interrupts()).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('after the window, an unconfirmed interim waits for the next revision to agree', () => {
    const f = fixture();
    f.bot(1, true);
    f.clock.advance(2000);
    f.send({ type: 'vad.start' });
    f.transcript('wait', 'interim');
    expect(f.interrupts()).toEqual([]);
    f.clock.advance(300);
    f.transcript('wait a minute', 'interim');
    expect(f.interrupts()).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('a sound alone never cuts the opening, even when the agent lets the VAD barge in', () => {
    const f = fixture({ minWordsWhileBotSpeaking: 0 });
    f.bot(1, true);
    f.clock.advance(2000);
    f.send({ type: 'vad.start' });
    expect(f.interrupts()).toEqual([]);
  });

  it('protects only the opening: once the caller has had a turn, one interim barges in', () => {
    const f = fixture();
    f.bot(1, true);
    f.clock.advance(5000);
    f.bot(1, false);
    f.send({ type: 'vad.start' });
    f.transcript('I want to go to Italy', 'final');
    f.send({ type: 'vad.stop' });
    f.clock.advance(1000);
    expect(f.turns()).toEqual(['I want to go to Italy']);
    f.bot(2, true);
    f.clock.advance(200);
    f.send({ type: 'vad.start' });
    f.transcript('no no wait', 'interim', 's2');
    expect(f.interrupts()).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('an agent that answers first has no opening to protect', () => {
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.transcript('hello is anyone there', 'final');
    f.send({ type: 'vad.stop' });
    f.clock.advance(1000);
    f.bot(1, true);
    f.clock.advance(100);
    f.send({ type: 'vad.start' });
    f.transcript('sorry go on', 'interim', 's2');
    expect(f.interrupts()).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('turned off, the opening barges in on the first interim as before', () => {
    const f = fixture({ opening: { protectMs: 0, confirmWords: false } });
    f.bot(1, true);
    f.clock.advance(100);
    f.transcript('please stop now', 'interim');
    expect(f.interrupts()).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('is part of the recommended phone row', () => {
    expect(PHONE_TURN_CONFIG.opening).toEqual({ protectMs: 1500, confirmWords: true });
  });
});
