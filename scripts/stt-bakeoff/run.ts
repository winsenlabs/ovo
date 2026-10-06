// The STT-10 bake-off: score recorded transcripts offline, or record new ones live with explicit keys.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NetPort } from '../../packages/contracts/src/index.ts';
import { createNodeNet } from '../../packages/plugin-kit/src/index.ts';
import { readWav } from './audio.ts';
import { transcribe } from './live.ts';
import { summarize, type ProviderSummary } from './metrics.ts';
import { CONTESTANTS } from './providers.ts';
import { formatReport } from './report.ts';
import {
  parseCorpus,
  type Corpus,
  type PriceTable,
  type ProviderId,
  type Recording,
} from './types.ts';

export interface BakeoffOptions {
  corpusDir: string;
  providers: readonly ProviderId[];
  /** Record new transcripts against the real providers. Needs each provider's key variable. */
  live?: boolean;
  usdInr: number;
  prices: PriceTable;
  env?: Readonly<Record<string, string | undefined>>;
  /** Tests replace the network with scripted fixtures; live runs use the production net. */
  net?: (provider: ProviderId) => NetPort;
  pace?: boolean;
  log?: (line: string) => void;
}

export async function loadCorpus(dir: string): Promise<Corpus> {
  return parseCorpus(JSON.parse(await readFile(join(dir, 'corpus.json'), 'utf8')));
}

/** Every saved recording under `<corpus>/recordings/<provider>/`, for the providers asked. */
export async function loadRecordings(
  dir: string,
  providers: readonly ProviderId[],
): Promise<Recording[]> {
  const recordings: Recording[] = [];
  for (const provider of providers) {
    const folder = join(dir, 'recordings', provider);
    const files = await readdir(folder).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith('.json')).sort())
      recordings.push(JSON.parse(await readFile(join(folder, file), 'utf8')) as Recording);
  }
  return recordings;
}

/**
 * Live mode: refuses unless every chosen provider's key variable is set and every utterance has
 * audio, then streams each utterance through each provider once and saves the transcripts over
 * the old ones. This is the only path that contacts a provider.
 */
async function recordLive(corpus: Corpus, options: BakeoffOptions): Promise<void> {
  const env = options.env ?? process.env;
  const missing = options.providers
    .map((provider) => CONTESTANTS[provider].keyEnv)
    .filter((name) => !env[name]);
  if (missing.length) throw new Error(`--live needs ${missing.join(', ')} (refusing to run)`);
  const silent = corpus.utterances.filter((utterance) => !utterance.audio);
  if (silent.length)
    throw new Error(`--live needs audio for ${silent.map((utterance) => utterance.id).join(', ')}`);
  for (const provider of options.providers) {
    const contestant = CONTESTANTS[provider];
    const owned = options.net ? undefined : createNodeNet();
    const net = options.net?.(provider) ?? owned!;
    try {
      const folder = join(options.corpusDir, 'recordings', provider);
      await mkdir(folder, { recursive: true });
      for (const utterance of corpus.utterances) {
        const audio = readWav(
          new Uint8Array(await readFile(join(options.corpusDir, utterance.audio!))),
        );
        const recording = await transcribe({
          provider,
          model: contestant.model,
          utteranceId: utterance.id,
          language: utterance.language,
          stt: contestant.create(net, env[contestant.keyEnv]!),
          audio,
          commits: contestant.commits,
          pace: options.pace,
        });
        await writeFile(
          join(folder, `${utterance.id}.json`),
          `${JSON.stringify(recording, null, 2)}\n`,
        );
        options.log?.(`${provider} ${utterance.id}: ${recording.error ?? 'recorded'}`);
      }
    } finally {
      await owned?.close();
    }
  }
}

export async function runBakeoff(
  options: BakeoffOptions,
): Promise<{ summaries: ProviderSummary[]; report: string }> {
  const corpus = await loadCorpus(options.corpusDir);
  if (options.live) await recordLive(corpus, options);
  const recordings = await loadRecordings(options.corpusDir, options.providers);
  const summaries = options.providers.map((provider) =>
    summarize(corpus, provider, recordings, options.prices, options.usdInr),
  );
  const synthetic =
    Boolean(corpus.synthetic) || recordings.some((recording) => recording.synthetic === true);
  return {
    summaries,
    report: formatReport(summaries, {
      synthetic,
      usdInr: options.usdInr,
      corpus: options.corpusDir,
    }),
  };
}
