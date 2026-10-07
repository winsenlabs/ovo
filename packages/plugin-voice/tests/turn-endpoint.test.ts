import { describe, expect, it } from 'vitest';
import type { EngineEvent, VoiceEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { projectBusEvents } from '../src/engine/engine-wiring.ts';
import { VoiceEventBus } from '../src/engine/events.ts';
import { TurnLatency } from '../src/engine/latency.ts';

/** The engine's bus feeding TurnLatency as the native engine wires it; the VAD waits 200 ms. */
function wired() {
  const clock = new FakeClock(1_000);
  const events: EngineEvent[] = [];
  const latency = new TurnLatency(clock, (event) => events.push(event), 200);
  const bus = new VoiceEventBus();
  projectBusEvents(bus, latency, { observe: () => undefined } as never, () => undefined);
  const say = (text: string, stability: 'interim' | 'final') =>
    bus.observe({
      type: 'stt',
      atMs: clock.now(),
      event: {
        type: 'transcript',
        segment: { segmentId: 's1', revision: 1, text, stability },
      },
    } satisfies VoiceEvent);
  const vad = (type: 'vad.start' | 'vad.stop') => bus.observe({ type, atMs: clock.now() });
  const timings = (turnId: string) =>
    events.flatMap((event) =>
      event.type === 'timing' && event.turnId === turnId ? [[event.key, event.ms]] : [],
    );
  return { clock, latency, say, vad, timings };
}

describe('the endpointing wait each speech turn reports (OBS-5 endpointMs)', () => {
  // Call 8cbac365 turn-1: VAD stop to final 443 ms, final to accepted 5 ms. Scribe sends no word
  // timings, so the worker's provider clock never measured the endpoint and endpointMs was null.
  it('is the VAD hangover plus the wait for the final and the turn: 200 + 443 + 5 ms', () => {
    const t = wired();
    t.vad('vad.start');
    t.say('Yes, sir.', 'interim');
    t.clock.advance(600);
    t.vad('vad.stop');
    t.clock.advance(443);
    t.say('Yes, sir. It takes a lot of time.', 'final');
    t.clock.advance(5);
    expect(t.latency.accept('turn-1', true)).toBe(648);
    expect(t.timings('turn-1')).toEqual([
      ['vad_stop_wait', 443],
      ['stt_finalize', 5],
    ]);
  });

  // Call 4e4d2228 turn-21 (13:02:30.761): "Um." was the only interim; the VAD never reported a stop
  // and no final came, so the turn ended on the stalled interim 1886 ms later with no stage at
  // all reported. That wait is now visible, measured from the words (a lower bound).
  it('times a turn the VAD never saw end from the last change to its words', () => {
    const t = wired();
    t.vad('vad.start');
    t.say('Um', 'interim');
    t.clock.advance(300);
    t.say('Um.', 'interim');
    t.clock.advance(1886);
    expect(t.latency.accept('turn-21', true)).toBe(1886);
    expect(t.timings('turn-21')).toEqual([]);
  });

  it('takes a final that repeats the interim as no new word', () => {
    const t = wired();
    t.say('Um.', 'interim');
    t.clock.advance(1500);
    t.say('Um.', 'final');
    t.clock.advance(2);
    expect(t.latency.accept('turn-1', true)).toBe(1502);
  });

  it('reports none for a key press', () => {
    const t = wired();
    expect(t.latency.accept('dtmf-1', false)).toBeUndefined();
  });

  it('starts every turn afresh', () => {
    const t = wired();
    t.vad('vad.start');
    t.vad('vad.stop');
    t.clock.advance(300);
    t.latency.accept('turn-1', true);
    t.clock.advance(5_000);
    expect(t.latency.accept('turn-2', true)).toBeUndefined();
  });
});
