import type { JevEvalGate, JevEvalOutcome, JevEvalTier } from './jev-eval.ts';

export interface Accuracy {
  total: number;
  correct: number;
  accuracy: number;
}

export interface JevEvalReport {
  overall: Accuracy;
  byListen: Record<string, Accuracy>;
  byLanguage: Record<string, Accuracy>;
  byTag: Record<string, Accuracy>;
  byTier: Record<JevEvalTier, Accuracy>;
  slots: Accuracy;
  /** listen → expected → predicted → count, every cell including the diagonal. */
  confusion: Record<string, Record<string, Record<string, number>>>;
  misroutes: JevEvalOutcome[];
  gate: { passed: boolean; failures: string[] };
}

const accuracy = (rows: readonly { correct: boolean }[]): Accuracy => {
  const correct = rows.filter((row) => row.correct).length;
  return { total: rows.length, correct, accuracy: rows.length ? correct / rows.length : 1 };
};

function grouped(outcomes: JevEvalOutcome[], keys: (outcome: JevEvalOutcome) => string[]) {
  const groups = new Map<string, JevEvalOutcome[]>();
  for (const outcome of outcomes)
    for (const key of keys(outcome)) groups.set(key, [...(groups.get(key) ?? []), outcome]);
  return Object.fromEntries(
    [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, accuracy(rows)]),
  );
}

export function summarizeJevEval(outcomes: JevEvalOutcome[], gate: JevEvalGate): JevEvalReport {
  const confusion: JevEvalReport['confusion'] = {};
  for (const { listen, expected, predicted } of outcomes) {
    const row = ((confusion[listen] ??= {})[expected] ??= {});
    row[predicted] = (row[predicted] ?? 0) + 1;
  }
  const slotRows = outcomes.flatMap((outcome) =>
    outcome.slotCorrect === undefined ? [] : [{ correct: outcome.slotCorrect }],
  );
  const report = {
    overall: accuracy(outcomes),
    byListen: grouped(outcomes, (outcome) => [outcome.listen]),
    byLanguage: grouped(outcomes, (outcome) => [outcome.language]),
    byTag: grouped(outcomes, (outcome) => outcome.tags),
    byTier: {
      rule: accuracy(outcomes.filter((outcome) => outcome.tier === 'rule')),
      decision: accuracy(outcomes.filter((outcome) => outcome.tier === 'decision')),
      error: accuracy(outcomes.filter((outcome) => outcome.tier === 'error')),
    },
    slots: accuracy(slotRows),
    confusion,
    misroutes: outcomes.filter((outcome) => !outcome.correct || outcome.slotCorrect === false),
  };
  const failures: string[] = [];
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  if (report.overall.accuracy < gate.minAccuracy)
    failures.push(`accuracy ${percent(report.overall.accuracy)} < ${percent(gate.minAccuracy)}`);
  for (const [listen, row] of Object.entries(report.byListen))
    if (row.accuracy < gate.minListenAccuracy)
      failures.push(`${listen} ${percent(row.accuracy)} < ${percent(gate.minListenAccuracy)}`);
  if (report.slots.accuracy < gate.minSlotAccuracy)
    failures.push(`slots ${percent(report.slots.accuracy)} < ${percent(gate.minSlotAccuracy)}`);
  // An unanswered case is a broken eval (a stale recording, a dead endpoint), never a score.
  if (report.byTier.error.total)
    failures.push(`${report.byTier.error.total} case(s) got no decision; re-record the answers`);
  return { ...report, gate: { passed: failures.length === 0, failures } };
}

/** The human-readable report: accuracy tables, the off-diagonal confusions, then every misroute. */
export function formatJevEvalReport(report: JevEvalReport, header: string[] = []): string {
  const pct = (row: Accuracy) =>
    `${(row.accuracy * 100).toFixed(1).padStart(5)}%  ${row.correct}/${row.total}`;
  const table = (title: string, rows: Record<string, Accuracy>) => [
    `${title}:`,
    ...Object.entries(rows)
      .filter(([, row]) => row.total > 0)
      .map(([key, row]) => `  ${key.padEnd(18)} ${pct(row)}`),
  ];
  const confusions = Object.entries(report.confusion).flatMap(([listen, rows]) =>
    Object.entries(rows).flatMap(([expected, predicted]) =>
      Object.entries(predicted)
        .filter(([key]) => key !== expected)
        .map(([key, count]) => `  ${listen}: ${expected} -> ${key}  x${count}`),
    ),
  );
  const misroutes = report.misroutes.map((outcome) => {
    const detail = [
      outcome.tier,
      outcome.confidence === undefined ? '' : `p=${outcome.confidence.toFixed(2)}`,
      outcome.modelChoice ? `model said ${outcome.modelChoice}` : '',
      outcome.correct ? 'wrong slot' : '',
      outcome.error ?? '',
    ].filter(Boolean);
    return `  ${outcome.id} [${outcome.listen}] "${outcome.text}" expected ${outcome.expected}, got ${outcome.predicted} (${detail.join(', ')})`;
  });
  return [
    ...header,
    `Overall: ${pct(report.overall)}   slots: ${pct(report.slots)}`,
    ...table('By listen set', report.byListen),
    ...table('By language', report.byLanguage),
    ...table('By tag', report.byTag),
    ...table('By tier', report.byTier),
    'Confusions (expected -> predicted):',
    ...(confusions.length ? confusions : ['  none']),
    'Misroutes:',
    ...(misroutes.length ? misroutes : ['  none']),
    report.gate.passed ? 'Gate: PASS' : `Gate: FAIL\n  ${report.gate.failures.join('\n  ')}`,
  ].join('\n');
}
