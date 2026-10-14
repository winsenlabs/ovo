// What the caller heard back: replies thrown away before a word was heard, the agent starting over
// the caller, turns or thoughts left with no answer, canned lines, fillers, and how long the caller
// waited for the first audio.
import type { GoldThought } from '../corpus/gold.ts';
import { cannedCategory, isPlatformLine, type AgentProfile } from '../corpus/profile.ts';
import { speechSpan, type AgentLine, type CallTimeline, type CallerTurn } from '../timeline.ts';
import { answeredTurns } from './segmentation.ts';

export type Span = { startMs: number; endMs: number };

/** A filler or search line: the platform's, not the model's answer. */
export function isFiller(profile: AgentProfile, line: AgentLine): boolean {
  return line.kind === 'acknowledgment' || isPlatformLine(profile, line.text);
}

/** Lines that answer the caller (not the disclosure, the opening or a filler). */
export function answerLines(profile: AgentProfile, timeline: CallTimeline): AgentLine[] {
  return timeline.agent.filter(
    (line) =>
      line.kind !== 'disclosure' && !isFiller(profile, line) && !line.turnId?.startsWith('opening'),
  );
}

export interface ReplyStats {
  /** Answer lines composed but never heard (superseded, interrupted before audio). */
  discardedLines: number;
  /** Answer lines cut off after their audio started. */
  cutLines: number;
  /** Answered turns whose reply was composed and none of it heard. */
  discardedReplies: number;
  /** Agent lines whose audio started while the caller was speaking. */
  talkOver: number;
  talkOverMs: number;
  cannedLines: number;
  canned: Record<string, number>;
  fillers: number;
  fillersComposed: number;
  /** Answered turns with no answer line heard. */
  missedTurnReplies: number;
  /** From each answered turn's last voiced audio to its first audio (any line, or its answer). */
  firstAudioMs: number[];
  firstAnswerMs: number[];
}

const byAudio = (a: AgentLine, b: AgentLine) => a.audibleAtMs! - b.audibleAtMs!;

function inside(spans: readonly Span[], atMs: number): Span | undefined {
  return spans.find((span) => atMs > span.startMs && atMs < span.endMs);
}

export function replyStats(
  timeline: CallTimeline,
  profile: AgentProfile,
  callerSpeech: readonly Span[],
): ReplyStats {
  const answers = answerLines(profile, timeline);
  const audible = timeline.agent.filter((line) => line.audibleAtMs !== undefined);
  const canned: Record<string, number> = {};
  for (const line of audible) {
    const category = cannedCategory(profile, line.text);
    if (category) canned[category] = (canned[category] ?? 0) + 1;
  }
  let talkOver = 0;
  let talkOverMs = 0;
  for (const line of audible) {
    const span = inside(callerSpeech, line.audibleAtMs!);
    if (!span) continue;
    talkOver++;
    talkOverMs += Math.min(span.endMs, line.endedAtMs ?? span.endMs) - line.audibleAtMs!;
  }
  const byTurn = new Map<string, AgentLine[]>();
  for (const line of timeline.agent)
    if (line.turnId) byTurn.set(line.turnId, [...(byTurn.get(line.turnId) ?? []), line]);
  let discardedReplies = 0;
  let missedTurnReplies = 0;
  const firstAudioMs: number[] = [];
  const firstAnswerMs: number[] = [];
  for (const turn of answeredTurns(timeline.turns)) {
    const lines = byTurn.get(turn.turnId) ?? [];
    const own = lines.filter((line) => answers.includes(line));
    const heard = own.filter((line) => line.audibleAtMs !== undefined).sort(byAudio);
    if (own.length && !heard.length) discardedReplies++;
    if (!heard.length) missedTurnReplies++;
    const end = speechSpan(turn).endMs;
    const first = lines.filter((line) => line.audibleAtMs !== undefined).sort(byAudio)[0];
    if (first) firstAudioMs.push(first.audibleAtMs! - end);
    if (heard[0]) firstAnswerMs.push(heard[0].audibleAtMs! - end);
  }
  return {
    discardedLines: answers.filter((line) => line.audibleAtMs === undefined).length,
    cutLines: answers.filter(
      (line) => line.audibleAtMs !== undefined && line.outcome === 'interrupted',
    ).length,
    discardedReplies,
    talkOver,
    talkOverMs: Math.round(talkOverMs),
    cannedLines: Object.values(canned).reduce((sum, count) => sum + count, 0),
    canned,
    fillers: audible.filter((line) => isFiller(profile, line)).length,
    fillersComposed: timeline.agent.filter((line) => isFiller(profile, line)).length,
    missedTurnReplies,
    firstAudioMs,
    firstAnswerMs,
  };
}

export interface ThoughtReplies {
  missed: GoldThought[];
  /** From each answered thought's last word to the first audio after it (any line / its answer). */
  firstAudioMs: number[];
  firstAnswerMs: number[];
  answeredBy: Map<string, AgentLine>;
}

/**
 * Against gold: a thought that wants a reply is answered when an answer line becomes audible after
 * the caller's last word and before the next thought starts (half a second either way).
 */
export function thoughtReplies(
  timeline: CallTimeline,
  profile: AgentProfile,
  thoughts: readonly GoldThought[],
): ThoughtReplies {
  const wanted = thoughts.filter((thought) => thought.expectsReply);
  const answers = answerLines(profile, timeline)
    .filter((line) => line.audibleAtMs !== undefined)
    .sort(byAudio);
  const audible = timeline.agent.filter((line) => line.audibleAtMs !== undefined).sort(byAudio);
  const result: ThoughtReplies = {
    missed: [],
    firstAudioMs: [],
    firstAnswerMs: [],
    answeredBy: new Map(),
  };
  wanted.forEach((thought, index) => {
    // Until the caller's next thought starts (or 15 s, for the last).
    const until = Math.min((wanted[index + 1]?.startMs ?? Infinity) + 500, thought.endMs + 15_000);
    const from = thought.endMs - 500;
    const answer = answers.find((line) => line.audibleAtMs! >= from && line.audibleAtMs! < until);
    const any = audible.find((line) => line.audibleAtMs! >= from && line.audibleAtMs! < until);
    if (!answer) result.missed.push(thought);
    else {
      result.answeredBy.set(thought.id, answer);
      result.firstAnswerMs.push(answer.audibleAtMs! - thought.endMs);
    }
    if (any) result.firstAudioMs.push(any.audibleAtMs! - thought.endMs);
  });
  return result;
}

/** Caller speech for talk-over: gold utterances, else the VAD trace, else the turns' speech. */
export function turnSpeech(turns: readonly CallerTurn[]): Span[] {
  return turns
    .filter((turn) => turn.endedAtMs !== undefined)
    .map((turn) =>
      turn.outcome === 'stopped'
        ? speechSpan(turn)
        : { startMs: turn.startedAtMs, endMs: turn.endedAtMs! },
    );
}
