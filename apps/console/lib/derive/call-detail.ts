// Pure client-side shaping for the call inspector (`/calls/[id]`). Mirrors `GET /v1/calls/:id/
// evidence`'s actual response shape; every chart/KPI below is derived here, never from a new
// endpoint (brief §3 CALLS).
import type { CallDiagnosis } from '../../components/inspector/call-diagnosis-panel';
import { routeLabel, type TurnRow } from '../../components/inspector/turn-model';
import type { DonutSlice } from '../../components/charts/donut';
import type { ConversationLine } from '../../components/ui/conversation';
import type { RecordingTrackSegment } from '../../components/operations/production-track-player';

export interface CostLine {
  id: string;
  provider: string;
  quantity: string;
  unit: string;
  amountMinor: string;
  currency: string;
  state: string;
  priceCardId: string;
  priceCardVersion: string;
}
export interface CostCurrencyTotal {
  currency: string;
  estimatedMinor: string;
  reconciledMinor: string;
  lines: number;
}
export interface CostEvidence {
  unpriced?: string[];
  currencies?: CostCurrencyTotal[];
  lines?: CostLine[];
}

export interface TranscriptLine {
  id?: string;
  speaker?: string;
  phase?: string;
  text: string;
  atMs?: number;
}

export interface CallEvidence {
  call: {
    id: string;
    agentId?: string;
    releaseId?: string;
    kind?: string;
    status?: string;
    createdAt?: string;
    completedAt?: string | null;
    durationMs?: number;
    outcome?: string;
  };
  selections?: Record<string, { pluginId: string; version: string; resolvedVersion?: string }>;
  transcript?: TranscriptLine[];
  latency?: {
    stage?: string;
    name?: string;
    durationMs: number;
    parts?: { key: string; ms: number }[];
  }[];
  cost?: CostEvidence;
  diagnosis?: CallDiagnosis;
  recording?: { id?: string; state?: string; source?: string; segments?: RecordingTrackSegment[] };
  events?: { id?: string; kind?: string; type?: string; at?: string; payload?: unknown }[];
  sttMode?: string;
}

/**
 * The transcript as `Conversation` lines. Agent turns that are not interim get the inline chip
 * ("first audio 772 ms · Jev → promise_to_pay 74%") by matching ordinally against `turns` — the
 * fixture/API carry no `turnId` on a transcript entry, so order is the only correspondence the
 * brief asks for ("TurnRow matched by order or turnId").
 */
export function toConversationLines(
  transcript: readonly TranscriptLine[] | undefined,
  turns: readonly TurnRow[] | undefined,
): ConversationLine[] {
  let agentOrdinal = -1;
  return (transcript ?? []).map((item, index) => {
    const isAgent = (item.speaker ?? '').toLowerCase() !== 'user';
    const interim = item.phase === 'interim';
    if (isAgent && !interim) agentOrdinal += 1;
    const turn = isAgent && !interim ? turns?.[agentOrdinal] : undefined;
    const route = turn ? routeLabel(turn) : undefined;
    return {
      id: item.id ?? `line-${index}`,
      speaker: isAgent ? 'agent' : 'caller',
      atMs: item.atMs ?? 0,
      text: item.text ?? '',
      interim,
      played: !interim,
      latencyMs: turn?.firstAudioMs ?? undefined,
      routeTier: route?.text,
    };
  });
}

/** A marker closer than this fraction of the call's total length to the one already kept would
 * land under axe's `target-size` minimum (24px) on the player's typical rendered width — a call
 * with many short turns otherwise packs markers closer than their own hit target. */
const MIN_MARKER_GAP_FRACTION = 0.04;

/** Turn-start offsets (ms from call start) for the player's "jump to turn" markers, thinned so
 * consecutive markers never sit closer than their own tap target on the call's total length. */
export function turnMarkers(
  turns: readonly TurnRow[] | undefined,
  callCreatedAt?: string | null,
  callDurationMs?: number | null,
) {
  const start = callCreatedAt ? Date.parse(callCreatedAt) : NaN;
  if (!turns || !turns.length || !Number.isFinite(start)) return [];
  // A turn's recorded start can run past the call's own duration (seen on short/failed calls,
  // where telemetry for a turn is generated independently of how long the call actually lasted):
  // keeping it would place the marker's `insetInlineStart` percentage past 100% of the track,
  // pushing the whole page wider than the viewport rather than just sitting off past the end.
  // Without a known duration to cap against, trust the data instead of discarding everything.
  const cap = callDurationMs != null && callDurationMs > 0 ? callDurationMs : Infinity;
  const all = turns
    .map((turn, index) => {
      const at = turn.startedAt ? Date.parse(turn.startedAt) : NaN;
      return Number.isFinite(at)
        ? { atMs: Math.max(0, at - start), label: `Turn ${index + 1}` }
        : null;
    })
    .filter(
      (marker): marker is { atMs: number; label: string } => marker != null && marker.atMs <= cap,
    );
  if (!all.length) return all;
  const totalMs = Math.max(1, callDurationMs ?? all[all.length - 1]!.atMs);
  const minGapMs = totalMs * MIN_MARKER_GAP_FRACTION;
  const thinned: { atMs: number; label: string }[] = [all[0]!];
  for (const marker of all.slice(1))
    if (marker.atMs - thinned[thinned.length - 1]!.atMs >= minGapMs) thinned.push(marker);
  return thinned;
}

/** Recording segment availability for the player's availability bar. */
export function audioSegments(segments: readonly RecordingTrackSegment[] | undefined) {
  return (segments ?? []).map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    available: segment.state === 'available',
  }));
}

export interface PrimaryCost {
  currency: string;
  totalMinor: number;
  provisional: boolean;
  others: string[];
}

/** One headline currency total for the KPI strip (no extra fetch — reads the evidence payload
 * already loaded); the Cost tab's own ledger fetch is what confirms "provisional" precisely, so
 * this treats any unpriced meter as a hint rather than the final word. */
export function primaryCost(cost: CostEvidence | undefined): PrimaryCost | null {
  const currencies = cost?.currencies ?? [];
  if (!currencies.length) return null;
  const [primary, ...rest] = [...currencies].sort((a, b) => b.lines - a.lines);
  return {
    currency: primary!.currency,
    totalMinor: Number(primary!.estimatedMinor) + Number(primary!.reconciledMinor),
    provisional: (cost?.unpriced?.length ?? 0) > 0,
    others: rest.map(
      (total) =>
        `${total.currency} ${(Number(total.estimatedMinor) + Number(total.reconciledMinor)).toLocaleString('en-IN')}`,
    ),
  };
}

/** Cost lines for one currency, summed by provider, for the Cost tab's per-currency donut. */
export function costByProvider(
  lines: readonly CostLine[] | undefined,
  currency: string,
): DonutSlice[] {
  const totals = new Map<string, number>();
  for (const line of lines ?? []) {
    if (line.currency !== currency) continue;
    totals.set(line.provider, (totals.get(line.provider) ?? 0) + Number(line.amountMinor));
  }
  return [...totals.entries()].map(([label, value]) => ({ label, value }));
}
