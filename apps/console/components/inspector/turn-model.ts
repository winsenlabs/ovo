'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { humaniseEnum } from '../../lib/status';
import type { BarSeriesPoint } from '../charts/bar-chart';
import type { WaterfallRow, WaterfallStage } from '../charts/waterfall';

/** The per-turn breakdown `GET /v1/calls/:id/turns` serves (plugin-observability `TurnTelemetry`). */
export interface TurnRow {
  turnId: string;
  input: 'speech' | 'dtmf' | 'initial' | 'agent';
  startedAt: string | null;
  endpointMs: number | null;
  vadStopToFinalMs: number | null;
  sttFinalizeMs: number | null;
  queueMs: number | null;
  groundingMs: number | null;
  decision: {
    ms: number;
    outcome: string;
    modelId: string | null;
    answers: {
      questionId: string;
      type: string;
      choice: string | null;
      value: number | null;
      confidence: number;
    }[];
    flow: { node: string | null; listen: string } | null;
  } | null;
  llmFirstTokenMs: number | null;
  llmTotalMs: number | null;
  llmCalls: number;
  firstSegmentMs: number | null;
  firstAudioMs: number | null;
  bargeInMs: number | null;
  interrupted: boolean;
  segments: {
    segmentId: string;
    ttsFirstByteMs: number | null;
    carrierFirstAudioMs: number | null;
    firstAudioAtMs: number | null;
    state: string | null;
  }[];
  userText: string | null;
  agentText: string | null;
  textOmitted: boolean;
}

/** The stages of a turn in the order they happen; each is its own interval, never a delta. */
export const STAGES = [
  { key: 'endpoint', label: 'Endpointing', color: 'var(--chart-8)' },
  { key: 'stt', label: 'STT final', color: 'var(--chart-2)' },
  { key: 'queue', label: 'Queue', color: 'var(--warn)' },
  { key: 'grounding', label: 'Grounding', color: 'var(--chart-7)' },
  { key: 'decision', label: 'Decision', color: 'var(--chart-3)' },
  { key: 'llm', label: 'LLM first token', color: 'var(--chart-4)' },
  { key: 'text', label: 'First sentence', color: 'var(--chart-5)' },
  { key: 'tts', label: 'TTS first byte', color: 'var(--accent)' },
  { key: 'carrier', label: 'Carrier first audio', color: 'var(--chart-6)' },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];
export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((item) => [item.key, item])) as Record<
  StageKey,
  (typeof STAGES)[number]
>;

const positive = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * A turn's stages as consecutive bar parts. The first sentence is what `firstSegmentMs` holds
 * beyond grounding, decision and the LLM's first token. Stages can overlap (a decision made on a
 * partial transcript runs while the caller still speaks), so `overlapMs` says how far their sum
 * passes the measured time to first audio; `unattributedMs` is the measured time no stage claims.
 */
export function turnParts(turn: TurnRow) {
  const first = turn.segments[0];
  const decision = positive(turn.decision?.ms);
  const before = positive(turn.groundingMs) + decision + positive(turn.llmFirstTokenMs);
  const parts: { key: StageKey; ms: number }[] = [
    { key: 'endpoint', ms: positive(turn.endpointMs) },
    { key: 'stt', ms: positive(turn.sttFinalizeMs) },
    { key: 'queue', ms: positive(turn.queueMs) },
    { key: 'grounding', ms: positive(turn.groundingMs) },
    { key: 'decision', ms: decision },
    { key: 'llm', ms: positive(turn.llmFirstTokenMs) },
    { key: 'text', ms: Math.max(0, positive(turn.firstSegmentMs) - before) },
    { key: 'tts', ms: positive(first?.ttsFirstByteMs) },
    { key: 'carrier', ms: positive(first?.carrierFirstAudioMs) },
  ];
  const present = parts.filter((part) => part.ms > 0);
  const sum = present.reduce((total, part) => total + part.ms, 0);
  const measured = positive(turn.firstAudioMs);
  // Endpointing happens before the turn's clock starts, so it is not part of time to first audio.
  const inside = sum - positive(turn.endpointMs);
  return {
    parts: present,
    totalMs: Math.max(sum, measured),
    unattributedMs: measured > inside ? measured - inside : 0,
    overlapMs: measured && inside > measured ? inside - measured : 0,
  };
}

const RULES_MODEL_ID = 'ovo.rules';

/** Which tier answered the turn, the way the POC labels it: rule, Jev, or the LLM. */
export function routeLabel(turn: TurnRow): { tier: string; text: string } | undefined {
  const decision = turn.decision;
  const chosen = decision?.answers.find((answer) => answer.choice) ?? decision?.answers[0];
  // The brief's "never raw snake_case" rule reaches here too: a route-decision chip is where a
  // caller-facing intent like `wrong_person` surfaced un-humanised in the transcript before.
  const verdict = chosen?.choice
    ? `${humaniseEnum(chosen.choice)} ${Math.round(chosen.confidence * 100)}%`
    : chosen?.value != null
      ? `${chosen.questionId} ${chosen.value.toFixed(2)}`
      : undefined;
  if (decision && decision.outcome !== 'succeeded') {
    const fallback = turn.llmCalls > 0 ? ' → LLM' : '';
    return {
      tier: 'error',
      text: `decision ${decision.outcome} after ${decision.ms} ms${fallback}`,
    };
  }
  if (turn.llmCalls > 0)
    return {
      tier: 'llm',
      text: `${decision ? `${verdict ?? 'decision'} → ` : ''}LLM ×${turn.llmCalls}`,
    };
  if (!decision) return undefined;
  if (decision.modelId === RULES_MODEL_ID)
    return { tier: 'rule', text: `rule → ${verdict ?? '—'}` };
  // A decision taken from a partial transcript settles before the turn: it shows as about 0 ms.
  const timing = decision.ms <= 5 ? 'ready from partials' : `${decision.ms} ms`;
  return { tier: 'jev', text: `Jev → ${verdict ?? '—'} · ${timing}` };
}

/** Nearest-rank percentile of the measured times; null with no samples. */
export function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]!;
}

/** Headline numbers for the turns the caller started: p50/p95 to first audio and tier counts. */
export function turnSummary(turns: readonly TurnRow[]) {
  const answered = turns.filter((turn) => turn.input === 'speech' || turn.input === 'dtmf');
  const times = answered
    .map((turn) => turn.firstAudioMs)
    .filter((value): value is number => typeof value === 'number' && value >= 0);
  const tiers: Record<string, number> = {};
  for (const turn of answered) {
    const tier = routeLabel(turn)?.tier ?? 'none';
    tiers[tier] = (tiers[tier] ?? 0) + 1;
  }
  return {
    turns: answered.length,
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    interrupted: turns.filter((turn) => turn.interrupted).length,
    tiers,
  };
}

/** Rows for the `Waterfall` chart (components/charts/waterfall.tsx), one per turn, on the shared
 * ms scale the chart itself picks from the data's own p95. */
export function turnWaterfall(turns: readonly TurnRow[]): {
  rows: WaterfallRow[];
  p95CapMs: number;
} {
  const withParts = turns.map((turn, index) => ({ index, ...turnParts(turn) }));
  const totals = withParts.map((item) => item.totalMs).sort((a, b) => a - b);
  const p95CapMs = Math.max(1, totals[Math.floor(totals.length * 0.95)] ?? totals.at(-1) ?? 1);
  const rows: WaterfallRow[] = withParts.map(({ index, parts, unattributedMs }) => ({
    label: `Turn ${index + 1}`,
    stages: parts.map((part): WaterfallStage => ({
      stage: STAGE_BY_KEY[part.key].label,
      ms: part.ms,
      color: STAGE_BY_KEY[part.key].color,
    })),
    unattributedMs,
  }));
  return { rows, p95CapMs };
}

/** Median ms per stage across every turn, for the stage-breakdown bar above the waterfall. */
export function stageBreakdown(turns: readonly TurnRow[]): BarSeriesPoint[] {
  const byStage = new Map<StageKey, number[]>(STAGES.map((item) => [item.key, []]));
  for (const turn of turns)
    for (const part of turnParts(turn).parts) byStage.get(part.key)!.push(part.ms);
  return STAGES.map((item) => ({
    category: item.label,
    values: { median: percentile(byStage.get(item.key) ?? [], 0.5) ?? 0 },
  })).filter((point) => point.values.median > 0);
}

/** First-audio ms per caller turn, in order, plus the p50/p95 reference lines around it. */
export function firstAudioSeries(turns: readonly TurnRow[]) {
  const answered = turns.filter((turn) => turn.input === 'speech' || turn.input === 'dtmf');
  const points = answered
    .map((turn, index) => ({ x: index + 1, y: turn.firstAudioMs ?? 0 }))
    .filter((point) => point.y > 0);
  const values = points.map((point) => point.y).sort((a, b) => a - b);
  return { points, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

/** `GET /v1/calls/:id/turns`, fetched independently per caller so one tab's failure never takes
 * another down with it (brief: "/turns, /outcome and /cost fail independently today and should
 * keep doing so"). */
export function useTurns(callId: string) {
  const [turns, setTurns] = useState<TurnRow[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setTurns(undefined);
    setError(undefined);
    void apiRequest<{ turns: TurnRow[] }>(`/calls/${encodeURIComponent(callId)}/turns`)
      .then(({ data }) => setTurns(data.turns))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Turn timings unavailable'),
      );
  }, [callId]);
  return { turns, error };
}
