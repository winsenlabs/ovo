import { describe, expect, it } from 'vitest';
import type { SpeechEvidence, VoiceEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { VoiceEventBus } from '../src/engine/events.ts';
import { TurnLatency } from '../src/engine/latency.ts';
import { SpeechEventProjector } from '../src/engine/speech-events.ts';

/** AGT-9: the agent is speaking once its audio reaches the carrier, not while TTS still works. */
function projector() {
  const bus = new VoiceEventBus();
  const bot: Extract<VoiceEvent, { type: 'bot.started' | 'bot.stopped' }>[] = [];
  bus.onEvent((event) => {
    if (event.type === 'bot.started' || event.type === 'bot.stopped') bot.push(event);
  });
  const events = new SpeechEventProjector(
    bus,
    new TurnLatency(new FakeClock(), () => undefined),
    () => undefined,
    () => undefined,
  );
  let sequence = 0;
  const evidence = (
    segmentId: string,
    phase: SpeechEvidence['phase'],
    { epoch = 1, kind = 'response', text = segmentId } = {},
  ) =>
    events.onSpeech({
      sequence: ++sequence,
      segmentId,
      text,
      epoch,
      kind: kind as SpeechEvidence['kind'],
      phase,
      at: sequence,
      evidence: 'estimated',
    });
  const states = () => bot.map((event) => `${event.type}:${event.epoch}`);
  return { bot, evidence, states };
}

describe('bot speaking state', () => {
  it('starts on the first carrier audio once the output reports it', () => {
    const p = projector();
    // The greeting teaches the projector that this output reports 'sent'.
    p.evidence('greeting', 'started', { epoch: 0 });
    p.evidence('greeting', 'sent', { epoch: 0 });
    p.evidence('greeting', 'completed', { epoch: 0 });
    p.bot.length = 0;
    p.evidence('reply', 'started');
    expect(p.states()).toEqual([]);
    p.evidence('reply', 'sent');
    expect(p.states()).toEqual(['bot.started:1']);
    p.evidence('reply', 'completed');
    expect(p.states()).toEqual(['bot.started:1', 'bot.stopped:1']);
  });

  it('never announces a line that is cut off before any audio', () => {
    const p = projector();
    p.evidence('greeting', 'started', { epoch: 0 });
    p.evidence('greeting', 'sent', { epoch: 0 });
    p.evidence('greeting', 'completed', { epoch: 0 });
    p.bot.length = 0;
    p.evidence('stale', 'started');
    p.evidence('stale', 'interrupted');
    expect(p.states()).toEqual([]);
  });

  it('keeps one interval for lines scheduled while the agent is already audible', () => {
    const p = projector();
    p.evidence('first', 'started');
    p.evidence('first', 'sent');
    p.evidence('second', 'started');
    p.evidence('first', 'completed');
    p.evidence('second', 'sent');
    p.evidence('second', 'completed');
    expect(p.states()).toEqual(['bot.started:1', 'bot.stopped:1']);
  });

  it('protects a confirmation from the moment it is scheduled', () => {
    const p = projector();
    p.evidence('greeting', 'started', { epoch: 0 });
    p.evidence('greeting', 'sent', { epoch: 0 });
    p.evidence('greeting', 'completed', { epoch: 0 });
    p.bot.length = 0;
    p.evidence('confirm', 'started', { kind: 'confirmation' });
    expect(p.bot).toMatchObject([{ type: 'bot.started', kind: 'confirmation' }]);
  });

  it('flags an interval that asks a question, announcing it again when a later line asks', () => {
    const p = projector();
    p.evidence('a', 'started', { text: 'I am calling from the bank.' });
    p.evidence('a', 'sent', { text: 'I am calling from the bank.' });
    p.evidence('b', 'started', { text: 'Am I speaking with Rahul?' });
    p.evidence('c', 'started', { text: 'Is now a good time?' });
    expect(p.bot).toEqual([
      { type: 'bot.started', epoch: 1, atMs: 1, kind: 'response' },
      { type: 'bot.started', epoch: 1, atMs: 3, kind: 'response', question: true },
    ]);
  });

  it('keeps the old timing for an output that never reports audio', () => {
    const p = projector();
    p.evidence('line', 'started');
    expect(p.states()).toEqual(['bot.started:1']);
  });
});
