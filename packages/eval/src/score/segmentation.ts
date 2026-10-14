// Turn segmentation against what the caller said: each turn the detector ended is matched to the
// gold thought its speech overlaps most. A thought that got two turns was split (the agent answered
// half a sentence); a turn spanning two thoughts merged them; a turn that ended before its thought
// did is a false endpoint. Thoughts are the gold's `thought` groups (a pause mid-sentence is not a
// new thought).
import type { GoldThought } from '../corpus/gold.ts';
import { speechSpan, type CallerTurn } from '../timeline.ts';

/** Slack on each side of a turn's speech: its start is the VAD's, after a 200 ms debounce. */
const SLACK_MS = 300;
/** A turn that ends this long before its thought's last word ended it early. */
const EARLY_MS = 250;

export interface TurnMatch {
  turn: CallerTurn;
  thought?: GoldThought;
  /** Other thoughts its speech covered (merged into it). */
  merged: GoldThought[];
  falseEndpoint: boolean;
}

export interface Segmentation {
  matches: TurnMatch[];
  /** Thoughts that want a reply. */
  thoughts: number;
  splitThoughts: number;
  /** Turns beyond one per thought. */
  extraTurns: number;
  mergedThoughts: number;
  falseEndpoints: number;
  /** Turns over no thought, or only over backchannels: noise, echo, a "hmm". */
  phantomTurns: number;
  /** Thoughts no turn ended or merged: the detector dropped them. */
  droppedThoughts: number;
  /** Per thought: its last turn's end less the thought's last word. */
  endpointLatenciesMs: number[];
  byThought: Map<string, TurnMatch[]>;
}

function overlap(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/** Stopped speech turns: the ones the agent was asked to answer. */
export function answeredTurns(turns: readonly CallerTurn[]): CallerTurn[] {
  return turns.filter((turn) => turn.outcome === 'stopped' && turn.input !== 'dtmf');
}

export function segment(
  turns: readonly CallerTurn[],
  thoughts: readonly GoldThought[],
): Segmentation {
  const byThought = new Map<string, TurnMatch[]>();
  const mergedInto = new Set<string>();
  const matches: TurnMatch[] = [];
  for (const turn of answeredTurns(turns)) {
    const span = speechSpan(turn);
    const window = { startMs: span.startMs - SLACK_MS, endMs: span.endMs + SLACK_MS };
    const covered = thoughts
      .map((thought) => ({ thought, ms: overlap(window, thought) }))
      .filter((entry) => entry.ms > 0);
    // A thought counts as heard by the turn when the turn heard most of it, not its edge. A turn
    // over several is the last one's (it ended after it); the others merged into it.
    const heard = covered.filter(
      (entry) => entry.ms >= Math.min(400, (entry.thought.endMs - entry.thought.startMs) / 2),
    );
    const pool = heard.length ? heard : covered.sort((a, b) => b.ms - a.ms).slice(0, 1);
    const best = pool.reduce<GoldThought | undefined>(
      (last, entry) => (!last || entry.thought.endMs > last.endMs ? entry.thought : last),
      undefined,
    );
    const merged = heard.map((entry) => entry.thought).filter((thought) => thought !== best);
    const match: TurnMatch = {
      turn,
      ...(best ? { thought: best } : {}),
      merged,
      falseEndpoint: Boolean(best && turn.endedAtMs! < best.endMs - EARLY_MS),
    };
    matches.push(match);
    if (best) byThought.set(best.id, [...(byThought.get(best.id) ?? []), match]);
    for (const thought of merged) mergedInto.add(thought.id);
  }
  const wanted = thoughts.filter((thought) => thought.expectsReply);
  let splitThoughts = 0;
  let extraTurns = 0;
  let mergedThoughts = 0;
  let droppedThoughts = 0;
  const endpointLatenciesMs: number[] = [];
  for (const thought of wanted) {
    const own = byThought.get(thought.id) ?? [];
    if (own.length > 1) {
      splitThoughts++;
      extraTurns += own.length - 1;
    }
    if (!own.length) {
      if (mergedInto.has(thought.id)) mergedThoughts++;
      else droppedThoughts++;
      continue;
    }
    const last = own.at(-1)!.turn;
    if (last.endedAtMs! >= thought.endMs - EARLY_MS)
      endpointLatenciesMs.push(last.endedAtMs! - thought.endMs);
  }
  return {
    matches,
    thoughts: wanted.length,
    splitThoughts,
    extraTurns,
    mergedThoughts,
    falseEndpoints: matches.filter((match) => match.falseEndpoint).length,
    phantomTurns: matches.filter((match) => !match.thought || !match.thought.expectsReply).length,
    droppedThoughts,
    endpointLatenciesMs,
    byThought,
  };
}

/** Without gold: turns that began under `withinMs` after the previous turn ended (call 8: 14). */
/**
 * The caller's transcribed segments no answered turn covers: written while none was open and not
 * within `lagMs` after one ended (a final lands a little after the endpoint). Coverage without gold:
 * a detector that stops answering leaves the caller's words uncovered however few turns it ends,
 * while one that merges a split thought still covers every segment of it.
 */
export function uncoveredSegments(
  turns: readonly CallerTurn[],
  segments: readonly { atMs: number }[],
  lagMs = 2000,
): number {
  const answered = answeredTurns(turns);
  return segments.filter(
    ({ atMs }) =>
      !answered.some((turn) => turn.startedAtMs <= atMs && atMs <= turn.endedAtMs! + lagMs),
  ).length;
}

export function quickRestarts(turns: readonly CallerTurn[], withinMs = 1000): number {
  const answered = answeredTurns(turns);
  let count = 0;
  for (let index = 1; index < answered.length; index++) {
    const previous = answered[index - 1]!;
    if (answered[index]!.startedAtMs - previous.endedAtMs! < withinMs) count++;
  }
  return count;
}
