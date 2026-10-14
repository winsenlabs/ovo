import { describe, expect, it } from 'vitest';
import {
  agentEvents,
  engineEvents,
  fromEngineEvents,
  modelledVad,
  timelineEvents,
} from './timeline.ts';

const row = (atMs: number, event: Record<string, unknown>) =>
  JSON.stringify({ type: 'engine.event', payload: { atMs, event } });
const speech = (
  atMs: number,
  segmentId: string,
  phase: string,
  kind = 'response',
  text = 'Where to?',
) => row(atMs, { type: 'speech', evidence: { segmentId, phase, kind, text } });

/** A call in the engine's events export shape (JSON lines; other event types are ignored). */
const EXPORT = [
  JSON.stringify({ type: 'session.started', payload: {} }),
  speech(1000, 'speech-1', 'started', 'response', 'Hi! Where are you thinking of going?'),
  speech(4000, 'speech-1', 'completed'),
  row(5000, { type: 'user.turn', phase: 'started', turnId: 'turn-1' }),
  row(5600, { type: 'user.transcript', segmentId: '0', stability: 'interim', text: 'Vienna' }),
  row(6300, {
    type: 'user.transcript',
    segmentId: '0',
    stability: 'final',
    text: 'Vienna, in December.',
  }),
  row(6305, {
    type: 'user.turn',
    phase: 'stopped',
    turnId: 'turn-1',
    text: 'Vienna, in December.',
    endpointRule: 'complete',
    endpointMs: 600,
  }),
  speech(7000, 'speech-2', 'started', 'acknowledgment', 'One moment.'),
  speech(7900, 'speech-2', 'completed'),
  speech(7920, 'speech-3', 'started', 'response', 'Lovely. Which dates?'),
  speech(9000, 'speech-3', 'interrupted'),
].join('\n');

describe('turn timelines', () => {
  it('reads transcripts, agent lines and live turns from an events export, timed from its first engine event', () => {
    expect(engineEvents(EXPORT)[0]!.at).toBe(0);
    const timeline = fromEngineEvents('c', 'call', EXPORT);
    expect(timeline.transcripts).toEqual([
      { at: 4600, type: 'transcript', seg: '0', text: 'Vienna', final: false },
      { at: 5300, type: 'transcript', seg: '0', text: 'Vienna, in December.', final: true },
    ]);
    expect(timeline.agent.map((a) => [a.start, a.stop, a.kind, a.state])).toEqual([
      [0, 3000, 'response', 'completed'],
      [6000, 6900, 'acknowledgment', 'completed'],
      [6920, 8000, 'response', 'interrupted'],
    ]);
    expect(timeline.live).toEqual([
      {
        id: 'turn-1',
        startedAt: 4000,
        endAt: 5305,
        text: 'Vienna, in December.',
        rule: 'complete',
        endpointMs: 600,
        reset: null,
      },
    ]);
  });

  it('plays the agent as the detector heard it: touching lines are one interval, fillers marked', () => {
    const { agent } = fromEngineEvents('c', 'call', EXPORT);
    expect(agentEvents(agent)).toEqual([
      {
        at: 0,
        type: 'agent.start',
        epoch: 1,
        kind: 'response',
        text: 'Hi! Where are you thinking of going?',
        question: true,
        filler: false,
      },
      { at: 3000, type: 'agent.stop', epoch: 1, kind: 'response' },
      {
        at: 6000,
        type: 'agent.start',
        epoch: 2,
        kind: 'acknowledgment',
        text: 'One moment.',
        question: false,
        filler: true,
      },
      // The reply joins the filler's interval: announced again, no longer a filler, now a question.
      {
        at: 6920,
        type: 'agent.start',
        epoch: 2,
        kind: 'response',
        text: 'Lovely. Which dates?',
        question: true,
        filler: false,
      },
      { at: 8000, type: 'agent.stop', epoch: 2, kind: 'acknowledgment' },
    ]);
  });

  it('models the VAD from the live turns when there is no audio', () => {
    const timeline = fromEngineEvents('c', 'call', EXPORT);
    const vad = modelledVad(timeline.live, timeline.transcripts);
    // From 300 ms before the first words to the turn's end, less its endpoint, plus the hangover.
    expect(vad.events).toEqual([
      { at: 4000, type: 'vad.start' },
      { at: 4905, type: 'vad.stop' },
    ]);
    const all = timelineEvents({ ...timeline, vad });
    expect(all.map((e) => e.type)).toEqual([
      'agent.start',
      'agent.stop',
      'vad.start',
      'transcript',
      'vad.stop',
      'transcript',
      'agent.start',
      'agent.start',
      'agent.stop',
    ]);
  });
});
