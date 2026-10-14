// One call's scorecard from its timeline (live or replayed) and, when there is one, its gold; and
// the aggregate over calls, recomputed from summed counts and pooled samples.
import type { Gold } from '../corpus/gold.ts';
import type { AgentProfile } from '../corpus/profile.ts';
import { speechSpans, type VadTrace } from '../corpus/vad-trace.ts';
import { speechSpan, type CallTimeline } from '../timeline.ts';
import { scoringWords } from './hinglish.ts';
import { emptyRaw, metricsOf, sumRaw, type Metrics, type RawScore } from './metrics.ts';
import { answerLines, replyStats, thoughtReplies, turnSpeech, type Span } from './replies.ts';
import { answeredTurns, quickRestarts, segment, uncoveredSegments } from './segmentation.ts';
import { segmentTexts, sttScore, type UtteranceRow } from './stt.ts';

export interface TurnRow {
  turnId: string;
  startMs: number;
  endMs?: number;
  outcome: string;
  rule?: string;
  endpointMs?: number;
  text: string;
  /** The gold thought it matched. */
  thought?: string;
  flags: string[];
  /** The first answer line heard for it, and when after the caller's last voiced audio. */
  reply?: string;
  replyAfterMs?: number;
  discardedLines: number;
}

/** An agent line, for the report's timeline. */
export interface LineRow {
  turnId?: string;
  kind: string;
  text: string;
  generatedMs: number;
  audibleMs?: number;
  endedMs?: number;
  outcome: string;
}

export interface CallScore {
  call: string;
  callId?: string;
  label?: string;
  mode: string;
  gold: boolean;
  /** Where talk-over's caller speech came from: gold, vad (audio or modelled) or turns. */
  speechSource: string;
  notes: string[];
  metrics: Metrics;
  raw: RawScore;
  canned: Record<string, number>;
  turns: TurnRow[];
  utterances: UtteranceRow[];
  lines: LineRow[];
}

export interface ScoreInput {
  call: string;
  callId?: string;
  label?: string;
  mode: string;
  notes?: string[];
  timeline: CallTimeline;
  profile: AgentProfile;
  gold?: Gold;
  vad?: VadTrace;
}

function callerSpeech(input: ScoreInput): { spans: Span[]; source: string } {
  if (input.gold?.utterances.length)
    return {
      spans: input.gold.utterances.map(({ startMs, endMs }) => ({ startMs, endMs })),
      source: 'gold',
    };
  if (input.vad) return { spans: speechSpans(input.vad, 200), source: `vad-${input.vad.source}` };
  return { spans: turnSpeech(input.timeline.turns), source: 'turns' };
}

export function scoreCall(input: ScoreInput): CallScore {
  const { timeline, profile, gold } = input;
  const raw = emptyRaw();
  const speech = callerSpeech(input);
  const replies = replyStats(timeline, profile, speech.spans);
  const answered = answeredTurns(timeline.turns);
  Object.assign(raw, {
    answeredTurns: answered.length,
    resetTurns: timeline.turns.filter((turn) => turn.outcome === 'reset').length,
    quickRestarts: quickRestarts(timeline.turns),
    discardedReplies: replies.discardedReplies,
    discardedLines: replies.discardedLines,
    cutLines: replies.cutLines,
    llmRequests: timeline.llm.length,
    talkOver: replies.talkOver,
    talkOverMs: replies.talkOverMs,
    missedTurnReplies: replies.missedTurnReplies,
    cannedLines: replies.cannedLines,
    fillers: replies.fillers,
  });
  raw.samples.firstAudioMs = replies.firstAudioMs;
  raw.samples.firstAnswerMs = replies.firstAnswerMs;
  const stt = sttScore(timeline.transcripts, gold, profile.languages);
  raw.foreignSegments = stt.foreignSegments;
  raw.foreignInterims = stt.foreignInterims;
  // Words only: a lone "." final is the STT hearing breath, not the caller saying something.
  const segments = segmentTexts(timeline.transcripts).filter((s) => scoringWords(s.text).length);
  raw.callerSegments = segments.length;
  raw.uncoveredSegments = uncoveredSegments(timeline.turns, segments);
  const flags = new Map<string, string[]>();
  const flag = (turnId: string, name: string) =>
    flags.set(turnId, [...(flags.get(turnId) ?? []), name]);
  const thoughtOf = new Map<string, string>();
  if (gold?.utterances.length) {
    const seg = segment(timeline.turns, gold.thoughts);
    const thoughts = thoughtReplies(timeline, profile, gold.thoughts);
    Object.assign(raw, {
      goldThoughts: seg.thoughts,
      goldTurns: answered.length,
      goldLlmRequests: timeline.llm.length,
      splitThoughts: seg.splitThoughts,
      extraTurns: seg.extraTurns,
      mergedThoughts: seg.mergedThoughts,
      falseEndpoints: seg.falseEndpoints,
      phantomTurns: seg.phantomTurns,
      droppedThoughts: seg.droppedThoughts,
      missedReplies: thoughts.missed.length,
      languageMismatches: stt.languageMismatches,
      sttEdits: stt.edits,
      sttWords: stt.words,
      sttCharEdits: stt.charEdits,
      sttChars: stt.chars,
    });
    raw.samples.endpointMs = seg.endpointLatenciesMs;
    raw.samples.replyLatencyMs = thoughts.firstAnswerMs;
    for (const match of seg.matches) {
      const id = match.turn.turnId;
      if (match.thought) thoughtOf.set(id, match.thought.id);
      if (match.falseEndpoint) flag(id, 'false-endpoint');
      if (!match.thought || !match.thought.expectsReply) flag(id, 'phantom');
      if (match.merged.length) flag(id, `merged:${match.merged.map((t) => t.id).join('+')}`);
      if (match.thought && (seg.byThought.get(match.thought.id)?.length ?? 0) > 1)
        flag(id, 'split');
    }
  }
  const answers = answerLines(profile, timeline);
  const rows: TurnRow[] = timeline.turns.map((turn) => {
    const own = answers.filter((line) => line.turnId === turn.turnId);
    const heard = own
      .filter((line) => line.audibleAtMs !== undefined)
      .sort((a, b) => a.audibleAtMs! - b.audibleAtMs!)[0];
    if (
      heard &&
      speech.spans.some((s) => heard.audibleAtMs! > s.startMs && heard.audibleAtMs! < s.endMs)
    )
      flag(turn.turnId, 'talk-over');
    if (turn.outcome === 'stopped' && own.length && !heard) flag(turn.turnId, 'reply-discarded');
    else if (turn.outcome === 'stopped' && !heard) flag(turn.turnId, 'no-reply');
    return {
      turnId: turn.turnId,
      startMs: Math.round(turn.startedAtMs),
      ...(turn.endedAtMs === undefined ? {} : { endMs: Math.round(turn.endedAtMs) }),
      outcome: turn.outcome === 'reset' ? `reset:${turn.resetReason ?? ''}` : turn.outcome,
      ...(turn.rule ? { rule: turn.rule } : {}),
      ...(turn.endpointMs === undefined ? {} : { endpointMs: turn.endpointMs }),
      text: turn.text ?? '',
      ...(thoughtOf.has(turn.turnId) ? { thought: thoughtOf.get(turn.turnId)! } : {}),
      flags: flags.get(turn.turnId) ?? [],
      ...(heard
        ? {
            reply: heard.text,
            replyAfterMs: Math.round(heard.audibleAtMs! - speechSpan(turn).endMs),
          }
        : {}),
      discardedLines: own.filter((line) => line.audibleAtMs === undefined).length,
    };
  });
  return {
    call: input.call,
    ...(input.callId ? { callId: input.callId } : {}),
    ...(input.label ? { label: input.label } : {}),
    mode: input.mode,
    gold: Boolean(gold?.utterances.length),
    speechSource: speech.source,
    notes: input.notes ?? [],
    metrics: metricsOf(raw),
    raw,
    canned: replies.canned,
    turns: rows,
    utterances: stt.rows,
    lines: timeline.agent.map((line) => ({
      ...(line.turnId ? { turnId: line.turnId } : {}),
      kind: line.kind,
      text: line.text,
      generatedMs: Math.round(line.generatedAtMs),
      ...(line.audibleAtMs === undefined ? {} : { audibleMs: Math.round(line.audibleAtMs) }),
      ...(line.endedAtMs === undefined ? {} : { endedMs: Math.round(line.endedAtMs) }),
      outcome: line.outcome,
    })),
  };
}

export interface Scorecard {
  version: 1;
  label: string;
  mode: string;
  createdAt: string;
  /** What ran: detector, STT, LLM, git commit. */
  config: Record<string, unknown>;
  calls: CallScore[];
  aggregate: Metrics;
}

export function scorecard(
  label: string,
  mode: string,
  config: Record<string, unknown>,
  calls: CallScore[],
  createdAt = new Date().toISOString(),
): Scorecard {
  return {
    version: 1,
    label,
    mode,
    createdAt,
    config,
    calls,
    aggregate: metricsOf(sumRaw(calls.map((call) => call.raw))),
  };
}
