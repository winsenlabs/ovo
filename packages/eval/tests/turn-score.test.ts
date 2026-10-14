import { describe, expect, it } from 'vitest';
import { parseGold } from '../src/corpus/gold.ts';
import { MAYA } from '../src/corpus/profile.ts';
import { replyStats, thoughtReplies } from '../src/score/replies.ts';
import { quickRestarts, segment } from '../src/score/segmentation.ts';
import type { AgentLine, CallTimeline, CallerTurn } from '../src/timeline.ts';

/** A stopped speech turn from `start` to `end` s, its last voiced audio `endpoint` ms before. */
const turn = (id: string, start: number, end: number, endpoint = 500): CallerTurn => ({
  turnId: id,
  startedAtMs: start * 1000,
  endedAtMs: end * 1000,
  outcome: 'stopped',
  input: 'speech',
  text: id,
  endpointMs: endpoint,
});
const line = (
  turnId: string,
  text: string,
  generated: number,
  audible?: number,
  ended?: number,
): AgentLine => ({
  segmentId: `${turnId}-${text}`,
  epoch: 1,
  kind: text === 'One moment.' ? 'acknowledgment' : 'response',
  text,
  generatedAtMs: generated * 1000,
  turnId,
  ...(audible === undefined ? {} : { audibleAtMs: audible * 1000 }),
  ...(ended === undefined ? {} : { endedAtMs: ended * 1000 }),
  outcome: audible === undefined ? 'interrupted' : 'completed',
});
const timeline = (turns: CallerTurn[], agent: AgentLine[] = [], llm = 0): CallTimeline => ({
  turns,
  agent,
  transcripts: [],
  llm: Array.from({ length: llm }, (_, n) => ({ atMs: n, id: `r${n}` })),
  interrupts: [],
  durationMs: 60_000,
});

// Three thoughts: t1 said in two parts with a 1.2 s pause, t2, t3; and a backchannel.
const gold = parseGold({
  utterances: [
    { id: 'u1', startMs: 1000, endMs: 3000, text: 'I want to go to', thought: 't1' },
    { id: 'u2', startMs: 4200, endMs: 6000, text: 'Paris in December', thought: 't1' },
    { id: 'u3', startMs: 10_000, endMs: 11_000, text: 'Two weeks', thought: 't2' },
    { id: 'u4', startMs: 11_600, endMs: 12_500, text: 'with my wife', thought: 't3' },
    { id: 'u5', startMs: 20_000, endMs: 20_300, text: 'mm', backchannel: true },
  ],
});

describe('turn segmentation against gold', () => {
  it('groups utterances into thoughts; a backchannel wants no reply', () => {
    expect(gold.thoughts.map((t) => [t.id, t.startMs, t.endMs, t.expectsReply])).toEqual([
      ['t1', 1000, 6000, true],
      ['t2', 10_000, 11_000, true],
      ['t3', 11_600, 12_500, true],
      ['u5', 20_000, 20_300, false],
    ]);
  });

  it('counts a split thought, its false endpoint, a merge, a phantom turn and the latencies', () => {
    const seg = segment(
      [
        // t1 split at the pause: the first turn ended at 3.5 s, while the thought went on to 6 s.
        turn('turn-1', 1.2, 3.5),
        turn('turn-2', 4.4, 6.6),
        // t2 and t3 heard as one turn.
        turn('turn-3', 10.2, 13.0),
        // "mm" answered as a turn.
        turn('turn-4', 20.1, 20.8),
      ],
      gold.thoughts,
    );
    expect(seg).toMatchObject({
      thoughts: 3,
      splitThoughts: 1,
      extraTurns: 1,
      mergedThoughts: 1,
      falseEndpoints: 1,
      phantomTurns: 1,
      droppedThoughts: 0,
    });
    expect(
      seg.matches.map((m) => [
        m.turn.turnId,
        m.thought?.id,
        m.merged.map((t) => t.id),
        m.falseEndpoint,
      ]),
    ).toEqual([
      ['turn-1', 't1', [], true],
      ['turn-2', 't1', [], false],
      ['turn-3', 't3', ['t2'], false],
      ['turn-4', 'u5', [], false],
    ]);
    // t1 ended 0.6 s after its last word; t3 0.5 s after.
    expect(seg.endpointLatenciesMs).toEqual([600, 500]);
  });

  it('counts a thought no turn ended as dropped', () => {
    expect(segment([turn('turn-1', 1.2, 6.5)], gold.thoughts)).toMatchObject({
      droppedThoughts: 2,
      mergedThoughts: 0,
    });
  });

  it('counts turns begun under a second after the last ended (no gold needed)', () => {
    expect(quickRestarts([turn('a', 1, 3), turn('b', 3.5, 5), turn('c', 7, 8)])).toBe(1);
  });
});

describe('what the caller heard back', () => {
  const turns = [turn('turn-1', 1, 6.5), turn('turn-2', 10.2, 13), turn('turn-3', 20, 22)];
  const agent = [
    line('turn-1', 'One moment.', 8, 8, 8.8),
    line('turn-1', 'Paris is lovely.', 9.5, 9.7, 11.0),
    // turn-2's reply composed and thrown away; the next turn's answer is canned.
    line('turn-2', 'Two weeks is plenty.', 13.9),
    line('turn-3', "I'm not completely sure about that. Want me to look it up?", 23, 23.2, 26),
  ];

  it('counts discarded replies, missed replies, canned lines, fillers and first audio', () => {
    const stats = replyStats(timeline(turns, agent, 5), MAYA, []);
    expect(stats).toMatchObject({
      discardedLines: 1,
      discardedReplies: 1,
      missedTurnReplies: 1,
      cannedLines: 1,
      canned: { uncertainty: 1 },
      fillers: 1,
      talkOver: 0,
    });
    // From each turn's last voiced audio (its end less 500 ms) to its first audio / its answer.
    expect(stats.firstAudioMs).toEqual([2000, 1700]);
    expect(stats.firstAnswerMs).toEqual([3700, 1700]);
  });

  it('counts the agent starting while the caller speaks, and for how long', () => {
    const stats = replyStats(timeline(turns, agent), MAYA, [{ startMs: 9500, endMs: 10_500 }]);
    expect(stats).toMatchObject({ talkOver: 1, talkOverMs: 800 });
  });

  it('against gold, a thought is answered by the first answer heard before the next starts', () => {
    const replies = thoughtReplies(timeline(turns, agent), MAYA, gold.thoughts);
    // t2's window closed when t3 began; t3's answer came 10.7 s after it, inside the 15 s window.
    expect(replies.missed.map((t) => t.id)).toEqual(['t2']);
    expect(replies.firstAnswerMs).toEqual([3700, 10_700]);
    expect(replies.firstAudioMs).toEqual([2000, 10_700]);
  });
});
