// Where the bake-off keeps its gold files, its recorded runs and its spend ledger.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchRecording } from './batch.ts';
import { parseGold, type GoldCall } from './gold.ts';
import type { StreamRecording } from './stream.ts';

/** The CLI's parsed options. */
export type Options = Record<string, string | boolean | undefined>;

const HERE = new URL('.', import.meta.url).pathname;
export const GOLD_DIR = join(HERE, '../../corpus/gold');
export const RUNS_DIR = join(HERE, '../../corpus/stt-runs');
export interface SpendEntry {
  config: string;
  call: string;
  seconds: number;
  at: string;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadGolds(dir = GOLD_DIR): Promise<GoldCall[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) =>
    /^call\d+\.json$/.test(file),
  );
  return Promise.all(
    files
      .sort()
      .map(async (file) => parseGold(JSON.parse(await readFile(join(dir, file), 'utf8')))),
  );
}

/** Every recorded run: `<runs>/<config>/<call>.json`. */
export async function loadRuns(dir = RUNS_DIR): Promise<(StreamRecording | BatchRecording)[]> {
  const runs: (StreamRecording | BatchRecording)[] = [];
  for (const config of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (config.includes('.')) continue; // the spend ledger; configurations are folders
    for (const file of (await readdir(join(dir, config)))
      .filter((name) => name.endsWith('.json'))
      .sort())
      runs.push(JSON.parse(await readFile(join(dir, config, file), 'utf8')));
  }
  return runs;
}

export function isStream(run: StreamRecording | BatchRecording): run is StreamRecording {
  return 'streamedMs' in run;
}

const LEDGER = join(RUNS_DIR, 'spend.jsonl');

/** The spend ledger: one JSON line per live run, appended, so parallel runs never clobber it. */
async function spent(): Promise<number> {
  const text = existsSync(LEDGER) ? await readFile(LEDGER, 'utf8') : '';
  return text
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + (JSON.parse(line) as SpendEntry).seconds, 0);
}

export async function spendGuard(
  planned: number,
  budgetMinutes: number,
  what: string,
): Promise<void> {
  const seconds = await spent();
  if (seconds + planned / 1000 > budgetMinutes * 60)
    throw new Error(
      `${what} would stream ${(planned / 60000).toFixed(1)} min on top of ${(seconds / 60).toFixed(1)} min already spent; the budget is ${budgetMinutes} min (refusing)`,
    );
}

export async function logSpend(entry: SpendEntry): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
  await appendFile(LEDGER, `${JSON.stringify(entry)}\n`);
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

/** A partial pass (`--only`) folded into the call's recording: its regions replace theirs. */
export function merge(base: StreamRecording, extra: StreamRecording): StreamRecording {
  const ids = new Set(extra.utterances.map((utterance) => utterance.id));
  return {
    ...base,
    streamedMs: base.streamedMs + extra.streamedMs,
    sessionMs: base.sessionMs + extra.sessionMs,
    usage: [...base.usage, ...extra.usage],
    utterances: [...base.utterances.filter((u) => !ids.has(u.id)), ...extra.utterances],
    ...(extra.error ? { error: [base.error, extra.error].filter(Boolean).join('; ') } : {}),
  };
}
