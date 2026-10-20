import type { Rate, RoutingScorecard } from '@winsendotai/ovo-plugin-router';

const pct = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);
const cell = (rate: Rate) => `${pct(rate.rate)} (${rate.correct}/${rate.total})`;
const row = (...cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const table = (head: string[], rows: (string | number)[][]) => [
  row(...head),
  row(...head.map(() => '---')),
  ...rows.map((cells) => row(...cells)),
];

/** The scorecard as markdown: what a pull request or a mini-ci log shows. */
export function markdownReport(
  card: RoutingScorecard,
  label: string,
  gate?: { ok: boolean; failures: string[] },
): string {
  const lines = [
    `# Routing eval: ${label}`,
    '',
    `Corpus **${card.corpus.name}** (${card.corpus.cases} cases, digest \`${card.corpus.digest.slice(0, 12)}\`), ` +
      `release digest \`${card.routing.digest.slice(0, 12)}\`, engines **${card.engineMode}**.`,
    '',
    card.engineMode === 'recorded'
      ? '_Engine answers are authored: this scores the tree, the rules and the pools, not a model._'
      : '_At least one engine ran for real: this measures that engine too._',
    '',
    `**${card.totals.passed} of ${card.totals.cases} cases pass.**`,
    '',
  ];
  if (gate)
    lines.push(
      gate.ok ? 'Gate: **pass**.' : '## Gate: FAIL',
      ...gate.failures.map((failure) => `- ${failure}`),
      '',
    );
  lines.push(
    '## Accuracy (cases that assert the field)',
    '',
    ...table(
      ['Field', 'Correct'],
      Object.entries(card.accuracy).map(([name, rate]) => [name, cell(rate)]),
    ),
    '',
    '## Rates',
    '',
    ...table(
      ['Rate', 'Value'],
      [
        ['fallback', cell(card.fallbackRate)],
        ['clarify (a re-ask was taken)', cell(card.clarifyRate)],
        ['end (the call ended or was undecided)', cell(card.endRate)],
      ],
    ),
    '',
    `Fallback steps reached: ${
      Object.entries(card.fallbackRate.byStep)
        .map(([step, n]) => `${step} ${n}`)
        .join(', ') || 'none'
    }.`,
    '',
    '## Engines',
    '',
    ...table(
      [
        'Engine',
        'Attempts',
        'Matched',
        'No match',
        'Low confidence',
        'Timeout',
        'Error',
        'Disabled',
      ],
      Object.entries(card.perEngine)
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
    ),
    '',
  );
  for (const [engine, matrix] of Object.entries(card.confusion))
    lines.push(
      `### Confusion: ${engine} (${matrix.correct}/${matrix.total} as expected)`,
      '',
      '_Rows: expected branch. Columns: branch chosen (`none`: nothing matched)._',
      '',
      ...table(
        ['expected \\ chosen', ...matrix.labels],
        matrix.labels.map((label, i) => [label, ...matrix.matrix[i]!]),
      ),
      '',
    );
  if (card.calibration.length)
    lines.push(
      '## Calibration (matched verdicts by confidence)',
      '',
      ...table(
        ['Engine', 'Confidence', 'Verdicts', 'Right'],
        card.calibration.map((c) => [c.engine, c.bucket, c.n, c.correct]),
      ),
      '',
    );
  lines.push(
    '## Nodes',
    '',
    ...table(
      ['Node', 'Cases', 'Decided', 'As expected', 'Fell back'],
      card.perNode.map((n) => [n.node, n.cases, n.decided, n.correct, n.fallbacks]),
    ),
    '',
    '## Tags',
    '',
    ...table(
      ['Tag', 'Cases', 'Passed'],
      Object.entries(card.byTag).map(([tag, t]) => [tag, t.cases, t.passed]),
    ),
    '',
  );
  if (card.failures.length)
    lines.push(
      '## Failures',
      '',
      ...card.failures.flatMap((failure) => [
        `- \`${failure.id}\``,
        ...failure.diff.map((d) => `  - ${d}`),
      ]),
      '',
    );
  lines.push(`Time: ${card.ms.total} ms total, p50 ${card.ms.p50} ms, p95 ${card.ms.p95} ms.`, '');
  return lines.join('\n');
}
