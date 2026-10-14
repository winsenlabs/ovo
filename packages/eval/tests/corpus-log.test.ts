import { describe, expect, it } from 'vitest';
import { parseGold } from '../src/corpus/gold.ts';
import { cannedCategory, MAYA, profileFrom } from '../src/corpus/profile.ts';
import { callEvents, parseExport, slimExport, type ExportedEvent } from '../src/log/export.ts';
import { buildTimeline } from '../src/timeline.ts';

const T0 = Date.parse('2026-10-14T17:58:48.971Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const engine = (ms: number, event: Record<string, unknown>): ExportedEvent => ({
  type: 'engine.event',
  at: at(ms + 100),
  payload: { atMs: T0 + ms, event },
});
const speech = (ms: number, phase: string, segmentId: string, text: string, kind = 'response') =>
  engine(ms, {
    type: 'speech',
    evidence: {
      sequence: ms,
      segmentId,
      text,
      epoch: 2,
      kind,
      phase,
      at: T0 + ms,
      evidence: 'generated',
    },
  });

const rows: ExportedEvent[] = [
  { type: 'session.started', at: at(0), callId: 'c-1', payload: { source: 'live' } },
  engine(1000, { type: 'user.turn', phase: 'started', turnId: 'turn-1' }),
  engine(1500, {
    type: 'user.transcript',
    turnId: '0',
    segmentId: '0',
    text: 'Hey',
    stability: 'interim',
  }),
  engine(2000, {
    type: 'user.transcript',
    turnId: '0',
    segmentId: '0',
    text: 'Hey Maya.',
    stability: 'final',
  }),
  engine(2010, {
    type: 'user.turn',
    phase: 'stopped',
    turnId: 'turn-1',
    input: 'speech',
    text: 'Hey Maya.',
    endpointMs: 520,
    endpointRule: 'complete',
  }),
  // The timing that names a line's turn comes before the line's own evidence.
  engine(3000, {
    type: 'timing',
    key: 'text_aggregation',
    turnId: 'turn-1',
    segmentId: 'speech-3',
    atMs: T0 + 3000,
  }),
  speech(3000, 'generated', 'speech-3', 'Hello!'),
  speech(3001, 'queued', 'speech-3', 'Hello!'),
  engine(3200, {
    type: 'timing',
    key: 'carrier_first_audio',
    turnId: 'turn-1',
    segmentId: 'speech-3',
    atMs: T0 + 3200,
  }),
  speech(4000, 'completed', 'speech-3', 'Hello!'),
  engine(3000, {
    type: 'timing',
    key: 'text_aggregation',
    turnId: 'turn-1',
    segmentId: 'speech-4',
    atMs: T0 + 3000,
  }),
  speech(3005, 'generated', 'speech-4', 'How can I help?'),
  speech(3500, 'interrupted', 'speech-4', 'How can I help?'),
  engine(5000, { type: 'user.turn', phase: 'started', turnId: 'turn-2' }),
  engine(5400, {
    type: 'user.turn',
    phase: 'reset',
    turnId: 'turn-2',
    text: 'mm',
    resetReason: 'backchannel',
  }),
  {
    type: 'provider.usage',
    at: at(3100),
    payload: {
      operation: 'inference',
      unit: 'input_tokens',
      requestId: 'r1',
      elapsedMs: 1100,
      state: 'reconciled',
    },
  },
  {
    type: 'provider.usage',
    at: at(3100),
    payload: { operation: 'inference', unit: 'output_tokens', requestId: 'r1', elapsedMs: 1100 },
  },
  {
    type: 'provider.usage',
    at: at(2600),
    payload: {
      operation: 'inference',
      unit: 'input_tokens',
      requestId: 'r0',
      elapsedMs: 700,
      state: 'estimated',
    },
  },
  {
    type: 'provider.usage',
    at: at(3100),
    payload: { operation: 'tts', unit: 'characters', requestId: 't1' },
  },
  { type: 'speculation.summary', at: at(6000), payload: { llm: { started: 2, used: 1 } } },
  engine(6000, { type: 'end', reason: 'caller_hangup' }),
  { type: 'session.ended', at: at(6000), payload: { reason: 'caller_hangup' } },
];

describe('the event export', () => {
  it('reads JSON lines, a JSON array and an { events } object alike', () => {
    const lines = rows.map((row) => JSON.stringify(row)).join('\n');
    expect(parseExport(lines)).toEqual(rows);
    expect(parseExport(JSON.stringify(rows))).toEqual(rows);
    expect(parseExport(JSON.stringify({ events: rows }))).toEqual(rows);
  });

  it('times engine events by the engine clock and LLM requests by when they were sent', () => {
    const events = callEvents(rows);
    expect(events.callId).toBe('c-1');
    expect(events.engine[0]).toMatchObject({ atMs: 1000 });
    // One request per id, sent `elapsedMs` before its usage was stored; aborted ones estimated.
    expect(events.llm).toEqual([
      { atMs: 1900, id: 'r0', elapsedMs: 700, estimated: true },
      { atMs: 2000, id: 'r1', elapsedMs: 1100 },
    ]);
    expect(events.speculation).toEqual({ started: 2, used: 1 });
    expect(events.endReason).toBe('caller_hangup');
  });

  it('slims an export to the rows the harness reads, which time the same', () => {
    const slim = slimExport(rows);
    expect(slim.length).toBeLessThan(rows.length);
    expect(slim.some((row) => row.payload?.unit === 'output_tokens')).toBe(false);
    const full = callEvents(rows);
    const kept = callEvents(slim);
    expect(buildTimeline(kept.engine, kept.llm)).toEqual(buildTimeline(full.engine, full.llm));
  });
});

describe('the timeline', () => {
  const events = callEvents(rows);
  const timeline = buildTimeline(events.engine, events.llm);

  it('has the caller turns, stopped and reset, with their rule and endpoint', () => {
    expect(timeline.turns).toEqual([
      {
        turnId: 'turn-1',
        startedAtMs: 1000,
        endedAtMs: 2010,
        outcome: 'stopped',
        input: 'speech',
        text: 'Hey Maya.',
        endpointMs: 520,
        rule: 'complete',
      },
      {
        turnId: 'turn-2',
        startedAtMs: 5000,
        endedAtMs: 5400,
        outcome: 'reset',
        text: 'mm',
        resetReason: 'backchannel',
      },
    ]);
  });

  it('has every agent line, its turn, when it was heard, and lines never heard', () => {
    expect(timeline.agent.map((l) => [l.segmentId, l.turnId, l.audibleAtMs, l.outcome])).toEqual([
      ['speech-3', 'turn-1', 3200, 'completed'],
      ['speech-4', 'turn-1', undefined, 'interrupted'],
    ]);
    expect(timeline.transcripts.map((t) => [t.text, t.final])).toEqual([
      ['Hey', false],
      ['Hey Maya.', true],
    ]);
    expect(timeline.end).toEqual({ atMs: 6000, reason: 'caller_hangup' });
  });
});

describe('gold files and agent profiles', () => {
  it('reads seconds, renderings, thoughts and review flags', () => {
    const gold = parseGold({
      units: 's',
      alignment: { offsetMs: -789 },
      utterances: [
        {
          id: 'u1',
          start: 1.5,
          end: 2.25,
          text: 'haan theek hai',
          devanagari: 'हाँ ठीक है',
          confidence: 'low',
        },
        { id: 'u2', start: 3, end: 4, text: 'mm', backchannel: true, needsFounderReview: true },
      ],
      needsFounderReview: ['u3'],
    });
    expect(gold.offsetMs).toBe(-789);
    expect(gold.utterances[0]).toMatchObject({
      startMs: 1500,
      endMs: 2250,
      references: ['haan theek hai', 'हाँ ठीक है'],
      expectsReply: true,
      lowConfidence: true,
    });
    expect(gold.utterances[1]).toMatchObject({ expectsReply: false, thought: 'u2' });
    expect(gold.needsReview).toEqual(['u3', 'u1', 'u2']);
    expect(() => parseGold({ utterances: [{ id: 'x', startMs: 5, endMs: 1, text: 'a' }] })).toThrow(
      /startMs <= endMs/,
    );
  });

  it('a profile file overrides the built-in one, its patterns from strings', () => {
    const profile = profileFrom({
      languages: ['en', 'ta'],
      canned: [{ category: 'say-again', pattern: 'once more' }],
    });
    expect(profile.languages).toEqual(['en', 'ta']);
    expect(cannedCategory(profile, 'Say that ONCE MORE?')).toBe('say-again');
    expect(cannedCategory(MAYA, 'Could you say the question again?')).toBe('say-again');
    expect(cannedCategory(MAYA, 'I’m not sure what you mean by “tez izafa.”')).toBe(
      'clarification',
    );
    expect(cannedCategory(MAYA, 'Zagreb is the capital of Croatia.')).toBeUndefined();
  });
});
