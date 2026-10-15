import type { Bakeoff } from './bakeoff.ts';
import type { Score } from './score.ts';

const ms = (value: number | undefined) => (value === undefined ? '–' : `${value}`);
const pct = (value: number) => `${Math.round(value * 100)}%`;

function row(name: string, calls: string, score: Omit<Score, 'detail'>): string {
  return `| ${name} | ${calls} | ${score.thoughts} | ${score.endpoints} | ${score.requestsPerThought.toFixed(2)} | ${score.falseEndpoints} | ${pct(score.splitRate)} | ${score.missed} | ${score.spurious} | ${score.duplicates} | ${ms(score.p50)} | ${ms(score.p90)} | ${score.slow} |`;
}

const HEADER = [
  '| variant | calls | thoughts | endpoints (LLM requests) | per thought | false endpoints | split rate | missed | spurious | duplicate | latency p50 ms | p90 ms | slow (>1.5 s) |',
  '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
];

/** The bake-off as markdown: the summary, each call, model costs and the per-thought detail. */
export function renderReport(result: Bakeoff, skipped: readonly string[] = []): string {
  const lines: string[] = ['# Turn bake-off results', ''];
  lines.push('## All calls', '', ...HEADER);
  for (const { variant, calls, score } of result.summary)
    lines.push(row(variant, calls.map((c) => c.replace('call', '')).join(','), score));
  lines.push('', '## Per call', '');
  for (const run of result.calls) {
    const align = run.alignment
      ? `, audio aligned at ${run.alignment.offsetMs} ms (${run.alignment.matched}/${run.alignment.candidates} live VAD starts matched)`
      : '';
    lines.push(`### ${run.label} (VAD ${run.vad}${align})`, '', ...HEADER);
    lines.push(row('live', '', run.live));
    for (const { variant, score } of run.results) lines.push(row(variant, '', score));
    lines.push('');
  }
  lines.push('## Model cost (wall clock per prediction on this machine)', '');
  lines.push('| model | predictions | p50 ms | p90 ms | max ms |', '|---|--:|--:|--:|--:|');
  for (const timing of result.timings.filter(
    (t) => !t.model.includes('@') && !t.model.includes(' '),
  ))
    lines.push(
      `| ${timing.model} | ${timing.predictions} | ${ms(timing.p50 && Math.round(timing.p50))} | ${ms(timing.p90 && Math.round(timing.p90))} | ${ms(timing.max)} |`,
    );
  if (skipped.length) lines.push('', `Skipped: ${skipped.join('; ')}`);
  lines.push('', '## Thoughts (gold) and what each variant did', '');
  lines.push(
    '`F<n>`: false endpoints inside the thought; a number: endpoint latency (ms); `miss`: no endpoint; `–`: no reply expected.',
    '',
  );
  for (const run of result.calls) {
    const variants = ['live', ...run.results.map((r) => r.variant)];
    lines.push(
      `### ${run.label}`,
      '',
      `| thought | words | ${variants.join(' | ')} |`,
      `|---|---|${variants.map(() => '--:').join('|')}|`,
    );
    for (const [index, thought] of run.thoughts.entries()) {
      const cell = (score: Score) => {
        const d = score.detail[index]!;
        if (!d.reply) return d.endpoints.length ? `– (${d.endpoints.length})` : '–';
        const parts = [
          d.false ? `F${d.false}` : '',
          d.latency === undefined ? 'miss' : `${d.latency}`,
        ];
        return parts.filter(Boolean).join(' ');
      };
      const words =
        thought.text.replace(/\|/g, '/').slice(0, 90) +
        (thought.note ? ` _(${thought.note})_` : '');
      lines.push(
        `| ${thought.id} | ${words} | ${[run.live, ...run.results.map((r) => r.score)].map(cell).join(' | ')} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
