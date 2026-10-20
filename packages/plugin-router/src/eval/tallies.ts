import type { EngineCounts, EngineName, Rate, RoutingScorecard } from '../wire/index.ts';
import type { CaseActual, NodeVerdict } from './actual.ts';

export const ENGINES: readonly EngineName[] = ['rules', 'decision', 'llm', 'external', 'context'];
const BUCKETS = ['0-0.5', '0.5-0.7', '0.7-0.9', '0.9-1'] as const;

export const rate = (correct: number, total: number): Rate => ({
  correct,
  total,
  rate: total ? correct / total : null,
});

export const emptyCounts = (): EngineCounts => ({
  attempts: 0,
  matched: 0,
  no_match: 0,
  low_confidence: 0,
  timeout: 0,
  error: 0,
  disabled: 0,
});

/** Every engine verdict, by engine and outcome. */
export function countEngines(actuals: readonly CaseActual[]): RoutingScorecard['perEngine'] {
  const counts = Object.fromEntries(ENGINES.map((engine) => [engine, emptyCounts()])) as Record<
    EngineName,
    EngineCounts
  >;
  for (const actual of actuals)
    for (const verdict of actual.verdicts) {
      const entry = counts[verdict.engine];
      entry.attempts += 1;
      entry[verdict.outcome as keyof Omit<EngineCounts, 'attempts'>] += 1;
    }
  return counts;
}

/** The verdict that decided `node`: its last `matched`, else the last engine that tried (chose nothing). */
function decider(actual: CaseActual, node: string): NodeVerdict | undefined {
  const tried = actual.verdicts.filter((verdict) => verdict.node === node);
  return tried.findLast((verdict) => verdict.outcome === 'matched') ?? tried.at(-1);
}

/** One expected branch against what decided it; absent when the router never reached the node. */
export interface Decision {
  node: string;
  engine: EngineName;
  expected: string;
  chosen: string;
  confidence?: number;
}

export function decisionsOf(
  expectations: Readonly<Record<string, string>> | undefined,
  actual: CaseActual,
): Decision[] {
  return Object.entries(expectations ?? {}).flatMap(([node, expected]) => {
    const verdict = decider(actual, node);
    if (!verdict) return [];
    const matched = verdict.outcome === 'matched' && verdict.branch;
    return [
      {
        node,
        engine: verdict.engine,
        expected,
        chosen: matched ? verdict.branch! : 'none',
        ...(matched && verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
      },
    ];
  });
}

/** Expected branch (rows) against chosen branch (columns), per deciding engine; `none` is last. */
export function confusionOf(decisions: readonly Decision[]): RoutingScorecard['confusion'] {
  const out: RoutingScorecard['confusion'] = {};
  for (const engine of ENGINES) {
    const own = decisions.filter((decision) => decision.engine === engine);
    if (!own.length) continue;
    const named = [...new Set(own.flatMap((d) => [d.expected, d.chosen]))].filter(
      (l) => l !== 'none',
    );
    const labels = [...named.sort(), ...(own.some((d) => d.chosen === 'none') ? ['none'] : [])];
    const matrix = labels.map(() => labels.map(() => 0));
    for (const d of own) matrix[labels.indexOf(d.expected)]![labels.indexOf(d.chosen)]! += 1;
    out[engine] = {
      labels,
      matrix,
      correct: own.filter((d) => d.expected === d.chosen).length,
      total: own.length,
    };
  }
  return out;
}

const bucketOf = (confidence: number) =>
  confidence < 0.5
    ? BUCKETS[0]
    : confidence < 0.7
      ? BUCKETS[1]
      : confidence < 0.9
        ? BUCKETS[2]
        : BUCKETS[3];

/** How often a confident verdict was right: matched model verdicts bucketed by their confidence. */
export function calibrationOf(decisions: readonly Decision[]): RoutingScorecard['calibration'] {
  const rows: RoutingScorecard['calibration'] = [];
  for (const engine of ['decision', 'llm', 'external'] as const)
    for (const bucket of BUCKETS) {
      const own = decisions.filter(
        (d) =>
          d.engine === engine &&
          d.chosen !== 'none' &&
          d.confidence !== undefined &&
          bucketOf(d.confidence) === bucket,
      );
      if (own.length)
        rows.push({
          engine,
          bucket,
          n: own.length,
          correct: own.filter((d) => d.expected === d.chosen).length,
        });
    }
  return rows;
}

/** Per node: cases that touched it, that it decided, that it decided as expected, that fell back there. */
export function nodesOf(
  cases: readonly {
    actual: CaseActual;
    expectations: Readonly<Record<string, string>> | undefined;
  }[],
): RoutingScorecard['perNode'] {
  const nodes = new Map<string, RoutingScorecard['perNode'][number]>();
  const at = (node: string) => {
    if (!nodes.has(node)) nodes.set(node, { node, cases: 0, decided: 0, correct: 0, fallbacks: 0 });
    return nodes.get(node)!;
  };
  for (const { actual, expectations } of cases) {
    const touched = new Set([...actual.verdicts.map((v) => v.node), ...actual.fallbackNodes]);
    for (const node of touched) {
      const entry = at(node);
      entry.cases += 1;
      if (node in actual.branches) entry.decided += 1;
      if (actual.fallbackNodes.includes(node)) entry.fallbacks += 1;
      if (expectations?.[node] !== undefined && actual.branches[node] === expectations[node])
        entry.correct += 1;
    }
  }
  return [...nodes.values()].sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}
