// The bake-off report: one row per provider, then each utterance's transcript for review.
import type { ProviderSummary } from './metrics.ts';

const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)}`);
const pct = (value: number | undefined) =>
  value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;

export function formatReport(
  summaries: readonly ProviderSummary[],
  context: { synthetic: boolean; usdInr: number; corpus: string },
): string {
  const lines = [
    '# STT bake-off (STT-10)',
    '',
    context.synthetic
      ? '**SYNTHETIC DATA: these numbers measure nothing.** Record a real corpus with `--live` (see scripts/stt-bakeoff/README.md).'
      : `Corpus: ${context.corpus}`,
    '',
    '| Provider | Model | Utterances | Failed | WER | WER Indian English | WER Hinglish | First partial p50 / p95 (ms) | Final after audio p50 / p95 (ms) | ₹ per audio hour |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summaries
      .map((s) =>
        [
          s.provider,
          s.model || '—',
          s.utterances,
          s.failures,
          pct(s.wer),
          pct(s.werByStyle['indian-english']),
          pct(s.werByStyle.hinglish),
          `${ms(s.firstPartialP50Ms)} / ${ms(s.firstPartialP95Ms)}`,
          `${ms(s.finalLatencyP50Ms)} / ${ms(s.finalLatencyP95Ms)}`,
          s.inrPerAudioHour === null ? 'unpriced' : s.inrPerAudioHour.toFixed(2),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
    `USD prices are converted at ₹${context.usdInr}/USD. Prices are list prices from scripts/stt-bakeoff/prices.json, not invoices.`,
    '',
    '## Transcripts',
  ];
  for (const summary of summaries) {
    lines.push('', `### ${summary.provider}`, '');
    for (const score of summary.scores)
      lines.push(
        `- \`${score.utteranceId}\` (${score.style}, ${score.errors}/${score.words} errors${score.failed ? ', FAILED' : ''}): ${score.hypothesis || '(nothing)'}`,
      );
  }
  return `${lines.join('\n')}\n`;
}
