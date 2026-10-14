// The scorecard as one self-contained HTML page (no scripts, no external files): headline numbers,
// the before/after diff and gate verdict, then per call a timeline and the turn and utterance tables.
import { METRICS } from '../score/metric-specs.ts';
import type { Metrics } from '../score/metrics.ts';
import type { CallScore, Scorecard } from '../score/scorecard.ts';
import type { DiffRow, ScorecardDiff } from './diff.ts';
import { formatValue } from './markdown.ts';
import { escapeHtml, timelineSvg } from './timeline-svg.ts';

const STYLE = `
:root{--fg:#1b1f24;--muted:#5d6670;--line:#d8dde3;--bg:#fff;--card:#f5f7f9;--good:#1a7f37;--bad:#cf222e;--warn:#9a6700;
--gold:#8250df;--turn:#0969da;--reset:#9aa4ae;--heard:#2da44e;--filler:#a2d9b1;--cut:#bf8700;--drop:#cf222e}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9da7b1;--line:#30363d;--bg:#0d1117;--card:#161b22}}
body{font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:1440px;padding:16px}
h1{font-size:22px}h2{font-size:18px;margin-top:32px;border-bottom:1px solid var(--line)}h3{font-size:15px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}.card{background:var(--card);border-radius:6px;padding:8px}
.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.better{color:var(--good)}.regression{color:var(--bad);font-weight:700}.worse{color:var(--warn)}
.pass{color:var(--good);font-weight:700}.fail{color:var(--bad);font-weight:700}.flags{color:var(--bad)}
.timeline{width:100%;height:auto;margin:8px 0}.timeline .label,.timeline text.tick{font-size:10px;fill:var(--muted)}
.timeline line.tick{stroke:var(--line)}.gold{fill:var(--gold)}.turn{fill:var(--turn)}.turn.bad{fill:var(--bad)}.turn.reset{fill:var(--reset)}
.line{fill:var(--heard)}.line.filler{fill:var(--filler)}.line.cut{fill:var(--cut)}.line.dropped{fill:var(--drop)}
.overflow{overflow-x:auto}`;

const HEADLINE = [
  'splitRate',
  'falseEndpointRate',
  'endpointP50Ms',
  'missedReplies',
  'missedTurnReplies',
  'discardedReplies',
  'llmPerTurn',
  'talkOver',
  'cannedLines',
  'firstAnswerP50Ms',
  'replyLatencyP50Ms',
  'wer',
  'cer',
  'languageMismatches',
];

const td = (text: string, cls = '') =>
  `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</td>`;
const th = (cells: string[]) =>
  `<tr>${cells.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr>`;

function cards(metrics: Metrics): string {
  return `<div class="cards">${HEADLINE.map((key) => METRICS.find((spec) => spec.key === key)!)
    .filter((spec) => metrics[spec.key] !== null && metrics[spec.key] !== undefined)
    .map(
      (spec) =>
        `<div class="card"><b>${escapeHtml(formatValue(metrics[spec.key], spec.unit))}</b><span>${escapeHtml(spec.label)}</span></div>`,
    )
    .join('')}</div>`;
}

function metricsTable(metrics: Metrics): string {
  const rows = METRICS.filter(
    (spec) => metrics[spec.key] !== null && metrics[spec.key] !== undefined,
  ).map(
    (spec) => `<tr>${td(spec.label)}${td(formatValue(metrics[spec.key], spec.unit), 'num')}</tr>`,
  );
  return `<table>${th(['Metric', 'Value'])}${rows.join('')}</table>`;
}

function diffTable(rows: readonly DiffRow[]): string {
  const body = rows
    .filter((row) => row.baseline !== null || row.candidate !== null)
    .map(
      (row) =>
        `<tr>${td(row.spec.label)}${td(formatValue(row.baseline, row.spec.unit), 'num')}${td(formatValue(row.candidate, row.spec.unit), 'num')}${td(row.delta === null ? '' : `${row.delta > 0 ? '+' : ''}${formatValue(row.delta, row.spec.unit)}`, `num ${row.verdict}`)}${td(row.verdict === 'same' || row.verdict === 'n/a' ? '' : row.verdict, row.verdict)}</tr>`,
    );
  return `<table>${th(['Metric', 'Baseline', 'Candidate', 'Δ', ''])}${body.join('')}</table>`;
}

function turnsTable(call: CallScore): string {
  const body = call.turns.map(
    (turn) =>
      `<tr>${td(turn.turnId)}${td(((turn.startMs ?? 0) / 1000).toFixed(1), 'num')}${td(turn.endMs === undefined ? '' : (turn.endMs / 1000).toFixed(1), 'num')}${td(turn.rule ?? turn.outcome)}${td(turn.endpointMs === undefined ? '' : String(Math.round(turn.endpointMs)), 'num')}${td(turn.text)}${td(turn.thought ?? '')}${td(turn.flags.join(' '), 'flags')}${td(turn.reply ?? '')}${td(turn.replyAfterMs === undefined ? '' : String(turn.replyAfterMs), 'num')}</tr>`,
  );
  return `<div class="overflow"><table>${th(['Turn', 'Start s', 'End s', 'Rule', 'Endpoint ms', 'Caller', 'Thought', 'Flags', 'First answer heard', 'After ms'])}${body.join('')}</table></div>`;
}

function utterancesTable(call: CallScore): string {
  const body = call.utterances.map(
    (u) =>
      `<tr>${td(u.id)}${td((u.startMs / 1000).toFixed(1), 'num')}${td(u.gold)}${td(u.heard)}${td(u.wer === null ? '–' : `${Math.round(u.wer * 100)}%`, 'num')}${td([u.languageMismatch ? 'wrong language' : '', u.lowConfidence ? 'gold low confidence' : ''].filter(Boolean).join(', '), 'flags')}</tr>`,
  );
  return `<div class="overflow"><table>${th(['Utterance', 'Start s', 'Said (gold)', 'Heard (STT)', 'WER', ''])}${body.join('')}</table></div>`;
}

export function htmlReport(card: Scorecard, diff?: ScorecardDiff): string {
  const out: string[] = [];
  out.push(`<h1>Call eval: ${escapeHtml(card.label)}</h1>`);
  out.push(
    `<p>Mode <b>${escapeHtml(card.mode)}</b>, ${card.calls.length} calls, ${escapeHtml(card.createdAt)}.</p>`,
  );
  out.push(
    `<table>${th(['Setting', 'Value'])}${Object.entries(card.config)
      .map(
        ([key, value]) =>
          `<tr>${td(key)}${td(typeof value === 'string' ? value : JSON.stringify(value))}</tr>`,
      )
      .join('')}</table>`,
  );
  if (diff) {
    const verdict = diff.regressions.length
      ? `<p class="fail">Gate: FAIL</p><ul>${diff.regressions.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
      : '<p class="pass">Gate: pass</p>';
    out.push(`<h2>Against ${escapeHtml(diff.baseline)}</h2>${verdict}${diffTable(diff.aggregate)}`);
  }
  out.push(
    `<h2>All calls</h2>${cards(card.aggregate)}<details><summary>Every metric</summary>${metricsTable(card.aggregate)}</details>`,
  );
  for (const call of card.calls) {
    const callDiff = diff?.calls.find((entry) => entry.call === call.call);
    const notes = [
      call.gold ? 'gold transcript' : 'no gold: metrics that need it are blank',
      `caller speech from ${call.speechSource}`,
      ...call.notes,
    ];
    out.push(
      `<h2>${escapeHtml(call.call)}${call.callId ? ` <small>${escapeHtml(call.callId)}</small>` : ''}</h2>`,
    );
    out.push(
      `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>${cards(call.metrics)}`,
    );
    out.push(timelineSvg(call));
    out.push(
      `<details><summary>Metrics${callDiff ? ' against the baseline' : ''}</summary>${callDiff ? diffTable(callDiff.rows) : metricsTable(call.metrics)}</details>`,
    );
    out.push(`<h3>Turns</h3>${turnsTable(call)}`);
    if (call.utterances.length) out.push(`<h3>Utterances</h3>${utterancesTable(call)}`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Call eval ${escapeHtml(card.label)}</title><style>${STYLE}</style></head><body>${out.join('\n')}</body></html>\n`;
}
