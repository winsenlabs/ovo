// The scorecard as Markdown: the aggregate, the before/after diff when there is a baseline, then
// each call's metrics, turns and (with gold) utterances.
import { METRICS, type MetricSpec } from '../score/metric-specs.ts';
import type { Metrics } from '../score/metrics.ts';
import type { CallScore, Scorecard } from '../score/scorecard.ts';
import type { DiffRow, ScorecardDiff } from './diff.ts';

export function formatValue(value: number | null | undefined, unit: MetricSpec['unit']): string {
  if (value === null || value === undefined) return '–';
  if (unit === 'rate') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'ratio') return value.toFixed(2);
  return String(Math.round(value));
}

const cell = (text: string, max = 80) =>
  (text.length > max ? `${text.slice(0, max - 1)}…` : text)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
const seconds = (ms: number | undefined) => (ms === undefined ? '' : (ms / 1000).toFixed(1));

function table(head: string[], body: string[][]): string {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function metricsTable(metrics: Metrics): string {
  const shown = METRICS.filter(
    (spec) => metrics[spec.key] !== null && metrics[spec.key] !== undefined,
  );
  return table(
    ['Metric', 'Value'],
    shown.map((spec) => [spec.label, formatValue(metrics[spec.key], spec.unit)]),
  );
}

const VERDICT: Record<DiffRow['verdict'], string> = {
  better: 'better',
  worse: 'worse',
  same: '',
  regression: '**REGRESSION**',
  'n/a': '',
};

export function diffTable(rows: readonly DiffRow[]): string {
  const shown = rows.filter((row) => row.baseline !== null || row.candidate !== null);
  return table(
    ['Metric', 'Baseline', 'Candidate', 'Δ', ''],
    shown.map((row) => [
      row.spec.label,
      formatValue(row.baseline, row.spec.unit),
      formatValue(row.candidate, row.spec.unit),
      row.delta === null
        ? ''
        : `${row.delta > 0 ? '+' : ''}${formatValue(row.delta, row.spec.unit)}`,
      VERDICT[row.verdict],
    ]),
  );
}

function turnsTable(call: CallScore): string {
  return table(
    [
      'Turn',
      'Start s',
      'End s',
      'Outcome',
      'Rule',
      'Endpoint ms',
      'Caller',
      'Thought',
      'Flags',
      'First answer heard',
      'After ms',
    ],
    call.turns.map((turn) => [
      turn.turnId,
      seconds(turn.startMs),
      seconds(turn.endMs),
      turn.outcome,
      turn.rule ?? '',
      turn.endpointMs === undefined ? '' : String(Math.round(turn.endpointMs)),
      cell(turn.text, 70),
      turn.thought ?? '',
      turn.flags.join(' '),
      cell(turn.reply ?? '', 50),
      turn.replyAfterMs === undefined ? '' : String(turn.replyAfterMs),
    ]),
  );
}

function utterancesTable(call: CallScore): string {
  return table(
    ['Utterance', 'Start s', 'End s', 'Said (gold)', 'Heard (STT)', 'WER', ''],
    call.utterances.map((u) => [
      u.id,
      seconds(u.startMs),
      seconds(u.endMs),
      cell(u.gold, 70),
      cell(u.heard, 70),
      u.wer === null ? '–' : `${Math.round(u.wer * 100)}%`,
      [u.languageMismatch ? 'wrong language' : '', u.lowConfidence ? 'gold low confidence' : '']
        .filter(Boolean)
        .join(', '),
    ]),
  );
}

export function markdownReport(card: Scorecard, diff?: ScorecardDiff): string {
  const out: string[] = [`# Call eval: ${card.label}`, ''];
  out.push(`Mode **${card.mode}**, ${card.calls.length} calls, ${card.createdAt}.`, '');
  out.push(
    table(
      ['Setting', 'Value'],
      Object.entries(card.config).map(([key, value]) => [
        key,
        cell(typeof value === 'string' ? value : JSON.stringify(value), 120),
      ]),
    ),
    '',
  );
  if (diff) {
    out.push(`## Against ${diff.baseline}`, '');
    out.push(
      diff.regressions.length
        ? `**Gate: FAIL**\n\n${diff.regressions.map((r) => `- ${r}`).join('\n')}`
        : '**Gate: pass**',
      '',
    );
    out.push(diffTable(diff.aggregate), '');
  }
  out.push('## All calls', '', metricsTable(card.aggregate), '');
  for (const call of card.calls) {
    out.push(
      `## ${call.call}${call.callId ? ` (${call.callId.slice(0, 8)})` : ''}${call.label ? `: ${call.label}` : ''}`,
      '',
    );
    const notes = [
      call.gold ? 'gold transcript' : 'no gold: metrics that need it are blank',
      `caller speech from ${call.speechSource}`,
      ...call.notes,
    ];
    out.push(notes.map((note) => `- ${note}`).join('\n'), '');
    const callDiff = diff?.calls.find((entry) => entry.call === call.call);
    out.push(callDiff ? diffTable(callDiff.rows) : metricsTable(call.metrics), '');
    out.push('### Turns', '', turnsTable(call), '');
    if (call.utterances.length) out.push('### Utterances', '', utterancesTable(call), '');
  }
  return `${out.join('\n')}\n`;
}
