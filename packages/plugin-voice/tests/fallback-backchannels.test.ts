import { describe, expect, it } from 'vitest';
import type { TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { FallbackTurns } from '../src/engine/fallback-turns.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** The detector used when no turn-detector plugin is selected (AGT-9, LAT-4). */
function fallback() {
  const turns = new FallbackTurns('agent', 'en-IN');
  const decisions: TurnDecision[] = [];
  turns.on((decision) => decisions.push(decision));
  const send = (event: WithoutTime<VoiceEvent>) =>
    turns.observe({ ...event, atMs: 0 } as VoiceEvent);
  let segment = 0;
  const transcript = (text: string, stability: 'interim' | 'final' = 'final') =>
    send({
      type: 'stt',
      event: {
        type: 'transcript',
        segment: { segmentId: `s${++segment}`, revision: 1, text, stability },
      },
    });
  const say = (text: string) => {
    transcript(text);
    send({ type: 'stt', event: { type: 'end-of-turn' } });
  };
  const speech = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'speech' ? [d.input.text] : [],
    );
  return { send, transcript, say, speech, decisions };
}

describe('FallbackTurns', () => {
  it('drops a Hinglish backchannel said over the agent', () => {
    const f = fallback();
    f.send({ type: 'bot.started', epoch: 1, kind: 'response' });
    f.say('haan ji theek hai');
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'response' });
    expect(f.decisions.filter((d) => d.type === 'interrupt')).toEqual([]);
    expect(f.speech()).toEqual([]);
  });

  it('holds a short answer to a question until the agent stops', () => {
    const f = fallback();
    f.send({ type: 'bot.started', epoch: 1, kind: 'response', question: true });
    f.say('haan');
    expect(f.speech()).toEqual([]);
    f.send({ type: 'bot.stopped', epoch: 1, kind: 'response' });
    expect(f.speech()).toEqual(['haan']);
  });

  it('announces partials under the id of the turn they become', () => {
    const f = fallback();
    f.transcript('I want', 'interim');
    f.say('I want to pay');
    expect(f.decisions).toEqual([
      { type: 'turn.partial', turnId: 'turn-1', text: 'I want', stable: false },
      { type: 'turn.partial', turnId: 'turn-1', text: 'I want to pay', stable: true },
      { type: 'turn.started', turnId: 'turn-1' },
      {
        type: 'turn.stopped',
        turnId: 'turn-1',
        input: { kind: 'speech', text: 'I want to pay', segments: 1 },
      },
    ]);
  });

  it('interrupts only once per interval, even when a question re-announces it', () => {
    const f = fallback();
    f.send({ type: 'bot.started', epoch: 1, kind: 'response' });
    f.transcript('wait wait I need', 'interim');
    f.send({ type: 'bot.started', epoch: 1, kind: 'response', question: true });
    f.transcript('wait wait I need to ask', 'interim');
    expect(f.decisions.filter((d) => d.type === 'interrupt')).toHaveLength(1);
  });
});
