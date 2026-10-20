import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  routingScorecardGate,
  scoreRoutingCorpus,
  ROUTING_SCORECARD_SCHEMA,
  type RoutingScorecard,
  type RoutingThresholds,
} from '@winsendotai/ovo-plugin-router';
import { loadCorpus, scoreSetup } from './corpus.ts';
import { markdownReport } from './report.ts';
import { workedExampleSnapshot } from './worked-example.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CORPUS = join(PACKAGE, 'corpus', 'routing', 'worked-example');
const log = (line: string) => process.stderr.write(`${line}\n`);

const USAGE = `pnpm eval:routing [run] [--corpus dir] [--label name] [--out dir]
     [--baseline scorecard.json [--thresholds file]] [--save-baseline file]
     [--assume-transfer] [--assume-human]
pnpm eval:routing diff <baseline.json> <candidate.json> [--thresholds file] [--out dir]
pnpm eval:routing snapshot [--corpus dir] [--write]
Exits 1 when the gate fails, 2 on a usage or run error.`;

/** A scorecard file: the scorecard, with the label (and, for a run, when and at which commit) beside it. */
export type ScorecardFile = RoutingScorecard & {
  label?: string;
  generatedAt?: string;
  commit?: string;
};

async function readCard(path: string): Promise<ScorecardFile> {
  const card = JSON.parse(await readFile(path, 'utf8')) as ScorecardFile;
  if (card.schema !== ROUTING_SCORECARD_SCHEMA)
    throw new Error(`${path}: not a routing scorecard (schema ${String(card.schema)})`);
  return card;
}

async function thresholdsFrom(path: string | undefined): Promise<RoutingThresholds> {
  return path ? (JSON.parse(await readFile(path, 'utf8')) as RoutingThresholds) : {};
}

function commit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined; // swallow-ok: a run outside a checkout records no commit.
  }
}

const writeJson = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 1)}\n`);

type Values = ReturnType<typeof parse>['values'];

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      corpus: { type: 'string' },
      label: { type: 'string' },
      out: { type: 'string' },
      baseline: { type: 'string' },
      thresholds: { type: 'string' },
      'save-baseline': { type: 'string' },
      live: { type: 'string' },
      keys: { type: 'string' },
      'assume-transfer': { type: 'boolean' },
      'assume-human': { type: 'boolean' },
      write: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
}

async function run(values: Values): Promise<number> {
  if (values.live !== undefined) {
    log(
      '--live needs engine credentials and is not available in this build (see docs/eval/routing.md).',
    );
    return 2;
  }
  const corpus = await loadCorpus(values.corpus ?? DEFAULT_CORPUS);
  const label = values.label ?? `routing-${corpus.manifest.name}`;
  const card = await scoreRoutingCorpus({
    snapshot: corpus.snapshot,
    cases: corpus.cases,
    name: corpus.manifest.name,
    engineMode: 'recorded',
    ...scoreSetup(corpus, { transfer: values['assume-transfer'], human: values['assume-human'] }),
  });
  const baseline = values.baseline ? await readCard(values.baseline) : undefined;
  const gate = baseline
    ? routingScorecardGate(baseline, card, await thresholdsFrom(values.thresholds))
    : undefined;
  const out = resolve(values.out ?? join(PACKAGE, 'out'));
  await mkdir(out, { recursive: true });
  const file: ScorecardFile = {
    ...card,
    label,
    generatedAt: new Date().toISOString(),
    ...(commit() ? { commit: commit()! } : {}),
  };
  await writeJson(join(out, `${label}.json`), file);
  await writeFile(join(out, `${label}.md`), markdownReport(card, label, gate));
  log(`wrote ${relative(process.cwd(), join(out, label)) || label}.{json,md}`);
  log(
    `cases=${card.totals.cases} passed=${card.totals.passed} accuracy=${card.accuracy.overall.rate === null ? 'n/a' : card.accuracy.overall.rate.toFixed(3)} ` +
      `fallback=${card.fallbackRate.rate?.toFixed(3)} clarify=${card.clarifyRate.rate?.toFixed(3)} end=${card.endRate.rate?.toFixed(3)}`,
  );
  if (values['save-baseline']) {
    // Time varies run to run and a baseline is committed: keep only what the gate reads.
    await writeJson(resolve(values['save-baseline']), {
      ...card,
      ms: { total: 0, p50: 0, p95: 0 },
      label,
    });
    log(`saved baseline ${values['save-baseline']}`);
  }
  for (const failure of card.failures) log(`FAIL ${failure.id}: ${failure.diff.join('; ')}`);
  if (gate && !gate.ok) {
    for (const failure of gate.failures) log(`GATE ${failure}`);
    return 1;
  }
  if (gate) log('gate passed');
  return 0;
}

async function diff(files: string[], values: Values): Promise<number> {
  const [baselinePath, candidatePath] = files;
  if (!baselinePath || !candidatePath)
    throw new Error('diff needs <baseline.json> <candidate.json>');
  const [baseline, candidate] = [await readCard(baselinePath), await readCard(candidatePath)];
  const gate = routingScorecardGate(baseline, candidate, await thresholdsFrom(values.thresholds));
  const report = markdownReport(candidate, candidate.label ?? 'candidate', gate);
  if (values.out) {
    await mkdir(resolve(values.out), { recursive: true });
    await writeFile(join(resolve(values.out), 'routing-diff.md'), report);
  }
  process.stdout.write(
    `${gate.ok ? 'gate passed' : 'gate FAILED'}\n${gate.failures.map((f) => `  ${f}`).join('\n')}\n`,
  );
  return gate.ok ? 0 : 1;
}

async function snapshot(values: Values): Promise<number> {
  const text = `${JSON.stringify(workedExampleSnapshot(), null, 1)}\n`;
  if (!values.write) return process.stdout.write(text) ? 0 : 0;
  const dir = resolve(values.corpus ?? DEFAULT_CORPUS);
  await writeFile(join(dir, 'snapshot.json'), text);
  log(`wrote ${join(dir, 'snapshot.json')}`);
  return 0;
}

export async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    log(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command = 'run', ...rest] = parsed.positionals;
  if (parsed.values.help) return (log(USAGE), 0);
  if (command === 'run') return run(parsed.values);
  if (command === 'diff') return diff(rest, parsed.values);
  if (command === 'snapshot') return snapshot(parsed.values);
  log(`unknown command ${command}\n${USAGE}`);
  return 2;
}
