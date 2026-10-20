import type { Rate, RoutingScorecard } from '@winsendotai/ovo-plugin-router';

/** The scorecard as renderer-neutral blocks, so the markdown and the HTML page cannot disagree. */
export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'text'; text: string; tone?: 'note' | 'pass' | 'fail' }
  | { kind: 'cards'; summary: string; items: { value: string; name: string }[] }
  | { kind: 'table'; head: string[]; rows: (string | number)[][]; bar?: boolean }
  | { kind: 'matrix'; head: string[]; rows: { label: string; cells: number[] }[] }
  | { kind: 'list'; items: { text: string; children?: string[] }[] };

export type Gate = { ok: boolean; failures: string[] };

export const pct = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);
export const rateText = (rate: Rate) => `${pct(rate.rate)} (${rate.correct}/${rate.total})`;

export function reportBlocks(card: RoutingScorecard, label: string, gate?: Gate): Block[] {
  const live = card.engineMode === 'live';
  const blocks: Block[] = [
    { kind: 'title', text: `Routing eval: ${label}` },
    {
      kind: 'text',
      text:
        `Corpus ${card.corpus.name} (${card.corpus.cases} cases, digest ${card.corpus.digest.slice(0, 12)}), ` +
        `release digest ${card.routing.digest.slice(0, 12)}, engines ${card.engineMode}.`,
    },
    {
      kind: 'text',
      tone: 'note',
      text: live
        ? 'At least one engine ran for real: this measures that engine too.'
        : 'Engine answers are authored: this scores the tree, the rules and the pools, not a model.',
    },
    {
      kind: 'cards',
      summary: `${card.totals.passed} of ${card.totals.cases} cases pass.`,
      items: [
        { value: `${card.totals.passed} / ${card.totals.cases}`, name: 'cases pass' },
        { value: pct(card.accuracy.overall.rate), name: 'accuracy' },
        { value: pct(card.fallbackRate.rate), name: 'reached a fallback' },
        { value: pct(card.clarifyRate.rate), name: 'asked again' },
        { value: pct(card.endRate.rate), name: 'ended or undecided' },
      ],
    },
  ];
  if (gate)
    blocks.push(
      gate.ok
        ? { kind: 'text', tone: 'pass', text: 'Gate: pass' }
        : { kind: 'heading', level: 2, text: 'Gate: FAIL' },
      ...(gate.ok
        ? []
        : [{ kind: 'list' as const, items: gate.failures.map((text) => ({ text })) }]),
    );
  blocks.push(
    { kind: 'heading', level: 2, text: 'Accuracy (cases that assert the field)' },
    {
      kind: 'table',
      bar: true,
      head: ['Field', 'Correct', 'Rate'],
      rows: Object.entries(card.accuracy).map(([name, r]) => [
        name,
        `${r.correct}/${r.total}`,
        pct(r.rate),
      ]),
    },
    { kind: 'heading', level: 2, text: 'Rates' },
    {
      kind: 'table',
      head: ['Rate', 'Value'],
      rows: [
        ['fallback', rateText(card.fallbackRate)],
        ['clarify (a re-ask was taken)', rateText(card.clarifyRate)],
        ['end (the call ended or was undecided)', rateText(card.endRate)],
      ],
    },
    {
      kind: 'text',
      text: `Fallback steps reached: ${
        Object.entries(card.fallbackRate.byStep)
          .map(([step, n]) => `${step} ${n}`)
          .join(', ') || 'none'
      }.`,
    },
    { kind: 'heading', level: 2, text: 'Engines' },
    {
      kind: 'table',
      head: [
        'Engine',
        'Attempts',
        'Matched',
        'No match',
        'Low confidence',
        'Timeout',
        'Error',
        'Disabled',
      ],
      rows: Object.entries(card.perEngine)
        .filter(([, c]) => c.attempts)
        .map(([name, c]) => [
          name,
          c.attempts,
          c.matched,
          c.no_match,
          c.low_confidence,
          c.timeout,
          c.error,
          c.disabled,
        ]),
    },
  );
  for (const [engine, m] of Object.entries(card.confusion))
    blocks.push(
      {
        kind: 'heading',
        level: 3,
        text: `Confusion: ${engine} (${m.correct}/${m.total} as expected)`,
      },
      {
        kind: 'text',
        tone: 'note',
        text: 'Rows: the branch expected at a node. Columns: the branch the engine chose (none: nothing matched).',
      },
      {
        kind: 'matrix',
        head: m.labels,
        rows: m.labels.map((label, i) => ({ label, cells: m.matrix[i]! })),
      },
    );
  if (card.calibration.length)
    blocks.push(
      { kind: 'heading', level: 2, text: 'Calibration (matched verdicts by confidence)' },
      {
        kind: 'table',
        head: ['Engine', 'Confidence', 'Verdicts', 'Right'],
        rows: card.calibration.map((c) => [c.engine, c.bucket, c.n, c.correct]),
      },
    );
  blocks.push(
    { kind: 'heading', level: 2, text: 'Nodes' },
    {
      kind: 'table',
      head: ['Node', 'Cases', 'Decided', 'As expected', 'Fell back'],
      rows: card.perNode.map((n) => [n.node, n.cases, n.decided, n.correct, n.fallbacks]),
    },
    { kind: 'heading', level: 2, text: 'Tags' },
    {
      kind: 'table',
      head: ['Tag', 'Cases', 'Passed'],
      rows: Object.entries(card.byTag).map(([tag, t]) => [tag, t.cases, t.passed]),
    },
  );
  if (card.failures.length)
    blocks.push(
      { kind: 'heading', level: 2, text: 'Failures' },
      { kind: 'list', items: card.failures.map((f) => ({ text: f.id, children: f.diff })) },
    );
  blocks.push({
    kind: 'text',
    tone: 'note',
    text: `Time: ${card.ms.total} ms total, p50 ${card.ms.p50} ms, p95 ${card.ms.p95} ms.`,
  });
  return blocks;
}
