import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '../src/index.ts';

type Untimed<T> = T extends unknown ? Omit<T, 'atMs'> : never;

function create(overrides: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const controller = createTurnDetector({ idle: null, ...overrides }).create({
    clock,
    vad: true,
    language: 'en-US',
    mode: 'agent',
  });
  const decisions: TurnDecision[] = [];
  controller.on((decision) => decisions.push(decision));
  const send = (event: Untimed<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const final = (text: string, segmentId: string) =>
    send({
      type: 'stt',
      event: { type: 'transcript', segment: { text, segmentId, revision: 1, stability: 'final' } },
    });
  const speech = () =>
    decisions.flatMap((decision) =>
      decision.type === 'turn.stopped' && decision.input.kind === 'speech'
        ? [decision.input.text]
        : [],
    );
  return { clock, controller, decisions, send, final, speech };
}

describe('mute boundaries in the production turn detector', () => {
  it('buffers confirmation without VAD interruption even at a zero word threshold', () => {
    const run = create({ minWordsWhileBotSpeaking: 0 });
    run.send({ type: 'confirmation.pending' });
    run.send({ type: 'bot.started', epoch: 1, kind: 'confirmation' });
    run.send({ type: 'vad.start' });
    expect(run.decisions.filter((decision) => decision.type === 'interrupt')).toEqual([]);
    run.final('yes', 'answer');
    run.send({ type: 'vad.stop' });
    expect(run.speech()).toEqual([]);
    run.send({ type: 'bot.stopped', epoch: 1, kind: 'confirmation' });
    expect(run.speech()).toEqual(['yes']);
    run.controller.dispose();
    expect(run.clock.pendingTimers).toBe(0);
  });

  for (const kind of ['disclosure', 'response'] as const) {
    it.each(['provider end', 'safety timeout', 'VAD timeout'])(
      `discards an earlier transcript during muted ${kind}, including a late %s`,
      (continuation) => {
        const run = create(kind === 'response' ? { mute: ['always-while-speaking'] } : {});
        if (continuation === 'VAD timeout') run.send({ type: 'vad.start' });
        run.final('please change my booking', 'old');
        if (continuation === 'VAD timeout') run.send({ type: 'vad.stop' });
        run.send({ type: 'bot.started', epoch: 1, kind });
        if (continuation === 'provider end')
          run.send({ type: 'stt', event: { type: 'end-of-turn' } });
        else run.clock.advance(6000);
        expect(run.speech()).toEqual([]);
        expect(run.decisions).toContainEqual({
          type: 'turn.reset',
          turnId: 'turn-1',
          reason: 'muted',
        });
        run.send({ type: 'bot.stopped', epoch: 1, kind });
        run.final('new request', 'new');
        run.send({ type: 'stt', event: { type: 'end-of-turn' } });
        expect(run.speech()).toEqual(['new request']);
        run.controller.dispose();
        expect(run.clock.pendingTimers).toBe(0);
      },
    );
  }
});
