// The bake-off report: one row per configuration, the pending ones, then every utterance's
// transcripts beside the gold for spot checks.
import type { ConfigStatus, SttConfig } from './configs.ts';
import { allRegions, type GoldCall, type GoldUtterance } from './gold.ts';
import type { ConfigSummary } from './score.ts';

const pct = (value: number | null) => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);
const ms = (value: number | null) => (value === null ? '–' : String(Math.round(value)));
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function formatReport(input: {
  summaries: readonly ConfigSummary[];
  configs: readonly { config: SttConfig; status: ConfigStatus }[];
  golds: readonly GoldCall[];
}): string {
  const lines = [
    '| Config | Utterances | WER | WER (loose) | CER | Call WER (loose) | WER en | loose WER hi | Wrong language (text / reported) | Empty | Noise words | Final after speech p50 / p90 ms | No final | $/min (list) | Streamed s |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of input.summaries)
    lines.push(
      `| ${[
        `${s.config}${s.errors.length ? ' (errors)' : ''}`,
        `${s.utterances - s.missing}/${s.utterances}`,
        pct(s.wer),
        pct(s.looseWer),
        pct(s.cer),
        pct(s.callLooseWer),
        pct(s.werEnglish),
        pct(s.looseWerHindi),
        `${s.misdetected} / ${s.reportedForeign}`,
        s.empty,
        s.insertions,
        `${ms(s.timeToFinalP50Ms)} / ${ms(s.timeToFinalP90Ms)}`,
        s.noFinal,
        `$${s.usdPerMinute.toFixed(4)}`,
        Math.round(s.streamedSeconds),
      ].join(' | ')} |`,
    );
  const errors = input.summaries.flatMap((s) => s.errors.map((error) => `- ${s.config}: ${error}`));
  if (errors.length) lines.push('', 'Run errors:', '', ...errors);
  const pending = input.configs.filter(({ status }) => status !== 'ready');
  if (pending.length) {
    lines.push('', '| Config | Status | Binding |', '| --- | --- | --- |');
    for (const { config, status } of pending)
      lines.push(`| ${config.id} | ${status} | ${cell(config.binding)} |`);
  }
  for (const gold of input.golds) {
    lines.push('', `### ${gold.call}`, '');
    for (const region of allRegions(gold)) {
      const utterance = 'text' in region ? (region as GoldUtterance) : undefined;
      lines.push(
        utterance
          ? `- **${region.id}** (${utterance.language}, ${utterance.confidence}): ${utterance.text}${utterance.devanagari ? ` / ${utterance.devanagari}` : ''}`
          : `- **${region.id}** (no words: ${region.note})`,
      );
      for (const summary of input.summaries) {
        const score = summary.scores.find(
          (candidate) => candidate.call === gold.call && candidate.id === region.id,
        );
        if (!score) continue;
        const flags = [
          score.speech ? `${score.wordErrors}/${score.words}` : `${score.insertions} inserted`,
          ...score.misdetection,
        ].join('; ');
        lines.push(`  - ${summary.config} (${flags}): ${score.hypothesis || '(nothing)'}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
