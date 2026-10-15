import type { Thought } from './gold.ts';
import type { ReplayResult } from './replay.ts';

/**
 * Scores a replay's endpoints against the gold thoughts (Wave 13, T2). Each endpoint (a speech
 * `turn.stopped`, so one LLM request) belongs to
 * the last thought expecting a reply that started before it:
 * - before that thought's end: a *false endpoint*: the caller was mid-thought; its reply would be
 *   asked for half of it and thrown away when they go on (the live engine's discarded replies);
 * - after its end: the thought's endpoint (its first one times the endpoint latency: from the end
 *   of the caller's voice);
 * - once the thought has had its endpoint: *spurious* when a thought that expects no reply (noise, a
 *   backchannel, words not the caller's) started since, else a *duplicate*.
 * A thought that expects a reply and gets no endpoint after its end, before the next one starts,
 * is a *missed* reply (the caller is left waiting, or answered only with the next thought).
 */
export interface Score {
  thoughts: number;
  endpoints: number;
  falseEndpoints: number;
  /** Thoughts with at least one false endpoint, over thoughts expecting a reply. */
  splitRate: number;
  splitThoughts: number;
  missed: number;
  spurious: number;
  duplicates: number;
  /** Endpoint latency of each answered thought (ms from the end of the caller's voice). */
  latencies: number[];
  /** Answered thoughts whose endpoint came more than SLOW_MS after the caller stopped. */
  slow: number;
  p50: number | undefined;
  p90: number | undefined;
  /** LLM requests (endpoints) per thought expecting a reply. */
  requestsPerThought: number;
  /** Per-thought detail, for the report. */
  detail: {
    id: string;
    text: string;
    reply: boolean;
    false: number;
    latency?: number;
    endpoints: string[];
  }[];
}

/** An endpoint this long after the caller stopped is felt as a pause (the live p90 is ~0.9 s). */
export const SLOW_MS = 1500;

export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low));
}

export function scoreReplay(
  result: Pick<ReplayResult, 'endpoints'>,
  thoughts: readonly Thought[],
): Score {
  const detail = thoughts.map((thought) => ({
    id: thought.id,
    text: thought.text,
    reply: thought.reply,
    false: 0,
    latency: undefined as number | undefined,
    endpoints: [] as string[],
  }));
  let falseEndpoints = 0;
  let spurious = 0;
  let duplicates = 0;
  for (const endpoint of result.endpoints) {
    // The last thought expecting a reply that started before the endpoint.
    const index = thoughts.findLastIndex(
      (thought) => thought.reply && thought.start <= endpoint.at,
    );
    const thought = thoughts[index];
    const row = detail[index];
    if (thought && row && (endpoint.at < thought.end || row.latency === undefined)) {
      row.endpoints.push(`${endpoint.at}${endpoint.reason ? ` ${endpoint.reason}` : ''}`);
      if (endpoint.at < thought.end) {
        falseEndpoints++;
        row.false++;
      } else row.latency = endpoint.at - thought.end;
      continue;
    }
    // Already answered (or before any): noise heard since, or a second request for the same words.
    const noise = thoughts.findLastIndex(
      (other) =>
        !other.reply && other.start <= endpoint.at && other.start >= (thought?.end ?? -Infinity),
    );
    if (noise >= 0 || !thought) {
      spurious++;
      if (noise >= 0)
        detail[noise]!.endpoints.push(
          `${endpoint.at}${endpoint.reason ? ` ${endpoint.reason}` : ''}`,
        );
    } else {
      duplicates++;
      row!.endpoints.push(`${endpoint.at} duplicate`);
    }
  }
  const replying = detail.filter((row) => row.reply);
  const latencies = replying.flatMap((row) => (row.latency === undefined ? [] : [row.latency]));
  const splitThoughts = replying.filter((row) => row.false > 0).length;
  return {
    thoughts: replying.length,
    endpoints: result.endpoints.length,
    falseEndpoints,
    splitRate: replying.length ? splitThoughts / replying.length : 0,
    splitThoughts,
    missed: replying.filter((row) => row.latency === undefined).length,
    spurious,
    duplicates,
    latencies,
    slow: latencies.filter((latency) => latency > SLOW_MS).length,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    requestsPerThought: replying.length ? result.endpoints.length / replying.length : 0,
    detail: detail.map((row) => ({
      ...row,
      ...(row.latency === undefined ? {} : { latency: row.latency }),
    })),
  };
}

/** Sums scores over calls (latency percentiles over every thought). */
export function aggregate(scores: readonly Score[]): Omit<Score, 'detail'> {
  const latencies = scores.flatMap((score) => score.latencies);
  const sum = (
    key:
      | 'thoughts'
      | 'endpoints'
      | 'falseEndpoints'
      | 'splitThoughts'
      | 'missed'
      | 'spurious'
      | 'duplicates',
  ) => scores.reduce((total, score) => total + score[key], 0);
  const thoughts = sum('thoughts');
  return {
    thoughts,
    endpoints: sum('endpoints'),
    falseEndpoints: sum('falseEndpoints'),
    splitThoughts: sum('splitThoughts'),
    splitRate: thoughts ? sum('splitThoughts') / thoughts : 0,
    missed: sum('missed'),
    spurious: sum('spurious'),
    duplicates: sum('duplicates'),
    latencies,
    slow: latencies.filter((latency) => latency > SLOW_MS).length,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    requestsPerThought: thoughts ? sum('endpoints') / thoughts : 0,
  };
}
