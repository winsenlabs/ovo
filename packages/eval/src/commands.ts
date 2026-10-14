// The eval:calls commands; cli.ts is the entry point.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readKeys, STT_CONFIGS, sttStatus } from './audio/stt-configs.ts';
import { DEFAULT_THRESHOLDS, diffScorecards, type Thresholds } from './report/diff.ts';
import { htmlReport } from './report/html.ts';
import { markdownReport } from './report/markdown.ts';
import { runEval, type Mode } from './run.ts';
import type { Scorecard } from './score/scorecard.ts';
import { slimCorpus } from './slim.ts';
import type { Transcript } from './timeline.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (line: string) => process.stderr.write(`${line}\n`);

async function json<T>(value: string): Promise<T> {
  return JSON.parse(value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value) as T;
}

async function thresholdsFrom(path: string | undefined): Promise<Thresholds> {
  return path
    ? { ...DEFAULT_THRESHOLDS, ...(await json<Thresholds>(`@${path}`)) }
    : DEFAULT_THRESHOLDS;
}

async function transcriptsFrom(dir: string): Promise<Record<string, Transcript[]>> {
  const out: Record<string, Transcript[]> = {};
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json')))
    out[file.slice(0, -5)] = (
      await json<{ transcripts: Transcript[] }>(`@${join(dir, file)}`)
    ).transcripts;
  return out;
}

function commit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined; // swallow-ok: a corpus run outside a checkout records no commit.
  }
}

async function writeReports(
  out: string,
  card: Scorecard,
  baseline?: Scorecard,
  thresholds?: Thresholds,
) {
  await mkdir(out, { recursive: true });
  const diff = baseline ? diffScorecards(baseline, card, thresholds) : undefined;
  await writeFile(join(out, `${card.label}.json`), `${JSON.stringify(card, null, 1)}\n`);
  await writeFile(join(out, `${card.label}.md`), markdownReport(card, diff));
  await writeFile(join(out, `${card.label}.html`), htmlReport(card, diff));
  log(`wrote ${join(out, card.label)}.{json,md,html}`);
  return diff;
}

function summary(card: Scorecard): string {
  const pick = [
    'answeredTurns',
    'splitRate',
    'falseEndpoints',
    'endpointP50Ms',
    'discardedReplies',
    'llmPerTurn',
    'missedReplies',
    'missedTurnReplies',
    'talkOver',
    'cannedLines',
    'firstAnswerP50Ms',
    'wer',
    'foreignSegments',
  ];
  return pick
    .filter((key) => card.aggregate[key] !== null)
    .map((key) => `${key}=${Number(card.aggregate[key]!.toFixed(3))}`)
    .join(' ');
}

async function run(values: Record<string, string | boolean | undefined>): Promise<number> {
  const mode = (values.mode ?? 'transcript') as Mode;
  if (!['live', 'transcript', 'audio'].includes(mode))
    throw new Error(`--mode ${mode}: live, transcript or audio`);
  if (values['llm-model'] && mode !== 'audio')
    throw new Error('--llm-model runs in real time: use it with --mode audio');
  const detector = String(values.detector ?? 'rules');
  const label = String(
    values.label ?? `${mode}-${detector.replace(/^module:.*\//, '').replace(/[^\w.-]+/g, '_')}`,
  );
  const corpus = String(values.corpus ?? join(PACKAGE, 'corpus'));
  const { card, transcripts } = await runEval({
    corpus,
    ...(values.calls ? { calls: String(values.calls).split(',') } : {}),
    mode,
    label,
    detector,
    ...(values['detector-config']
      ? { detectorConfig: await json(String(values['detector-config'])) }
      : {}),
    ...(values.vad ? { vad: values.vad as 'trace' | 'audio' } : {}),
    ...(values.stt ? { stt: String(values.stt) } : {}),
    ...(values.keys ? { keysFile: String(values.keys) } : {}),
    ...(values['llm-model'] ? { llmModel: String(values['llm-model']) } : {}),
    ...(values.transcripts
      ? { transcripts: await transcriptsFrom(String(values.transcripts)) }
      : {}),
    config: { corpus: relative(process.cwd(), corpus) || '.', commit: commit() ?? 'unknown' },
    log,
  });
  const out = String(values.out ?? join(PACKAGE, 'out'));
  for (const [call, entry] of Object.entries(transcripts)) {
    await mkdir(join(out, label, 'transcripts'), { recursive: true });
    await writeFile(join(out, label, 'transcripts', `${call}.json`), `${JSON.stringify(entry)}\n`);
  }
  const baseline = values.baseline ? await json<Scorecard>(`@${values.baseline}`) : undefined;
  const thresholds = await thresholdsFrom(values.thresholds as string | undefined);
  const diff = await writeReports(out, card, baseline, thresholds);
  if (values['save-baseline']) {
    // The gate reads only the metrics: the per-turn tables stay in the run's own reports.
    const compact = {
      ...card,
      calls: card.calls.map((call) => ({ ...call, turns: [], utterances: [], lines: [] })),
    };
    await writeFile(String(values['save-baseline']), `${JSON.stringify(compact, null, 1)}\n`);
    log(`wrote the baseline ${String(values['save-baseline'])}`);
  }
  process.stdout.write(`${label}: ${summary(card)}\n`);
  if (!diff) return 0;
  if (!diff.regressions.length) process.stdout.write(`gate: pass against ${diff.baseline}\n`);
  else
    process.stdout.write(
      `gate: FAIL against ${diff.baseline}\n${diff.regressions.map((r) => `  ${r}`).join('\n')}\n`,
    );
  return diff.regressions.length ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries(
      [
        'mode',
        'corpus',
        'calls',
        'label',
        'detector',
        'detector-config',
        'vad',
        'stt',
        'keys',
        'llm-model',
        'transcripts',
        'out',
        'baseline',
        'thresholds',
        'save-baseline',
        'from',
        'to',
      ].map((name) => [name, { type: 'string' as const }]),
    ),
  });
  const [command = 'run', ...rest] = positionals;
  if (command === 'run') return run(values);
  if (command === 'slim') {
    if (!values.from || !values.to) throw new Error('slim needs --from and --to');
    await slimCorpus(values.from, values.to, values.calls?.split(','), log);
    return 0;
  }
  if (command === 'diff') {
    if (rest.length !== 2) throw new Error('diff needs <baseline.json> <candidate.json>');
    const [baseline, candidate] = await Promise.all(
      rest.map((path) => json<Scorecard>(`@${path}`)),
    );
    const diff = await writeReports(
      String(values.out ?? join(PACKAGE, 'out')),
      candidate!,
      baseline,
      await thresholdsFrom(values.thresholds),
    );
    process.stdout.write(
      diff!.regressions.length ? `gate: FAIL\n${diff!.regressions.join('\n')}\n` : 'gate: pass\n',
    );
    return diff!.regressions.length ? 1 : 0;
  }
  if (command === 'stt-configs') {
    const keys = await readKeys(values.keys && existsSync(values.keys) ? values.keys : undefined);
    for (const config of STT_CONFIGS)
      process.stdout.write(
        `${config.id.padEnd(24)}${sttStatus(config, keys).padEnd(14)}${config.description}\n`,
      );
    return 0;
  }
  throw new Error(`unknown command ${command}: run, diff, slim or stt-configs`);
}
