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
  { key: 'endpoint', label: 'Endpointing', color: 'var(--color-text-muted)' },
  { key: 'stt', label: 'STT final', color: '#7a8a80' },
  { key: 'queue', label: 'Queue', color: 'var(--color-warning)' },
  { key: 'grounding', label: 'Grounding', color: '#8c6d3f' },
  { key: 'decision', label: 'Decision', color: '#3f6f8c' },
  { key: 'llm', label: 'LLM first token', color: '#6b4f8c' },
  { key: 'text', label: 'First sentence', color: '#a0789a' },
  { key: 'tts', label: 'TTS first byte', color: 'var(--color-accent)' },
  { key: 'carrier', label: 'Carrier first audio', color: '#9aa79f' },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];

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
  const verdict = chosen?.choice
    ? `${chosen.choice} ${Math.round(chosen.confidence * 100)}%`
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
