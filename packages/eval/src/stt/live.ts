// The live commands: they stream audio to providers and cost money, so each checks the spend
// ledger against the budget first and records what it spent.
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeNet } from '../../../plugin-kit/src/index.ts';
import {
  assemblyAiBatch,
  compress,
  scribeBatch,
  wordsByUtterance,
  type BatchRecording,
} from './batch.ts';
import { TRAVEL_KEYTERMS, configById, configStatus } from './configs.ts';
import { loadCall, plannedStreamMs, streamWindows } from './corpus.ts';
import { allRegions } from './gold.ts';
import { loadKeys } from './keys.ts';
import {
  RUNS_DIR,
  loadGolds,
  logSpend,
  merge,
  readJsonFile,
  spendGuard,
  writeJson,
  type Options,
} from './store.ts';
import { streamCall, tapNet, type StreamRecording } from './stream.ts';
import { slicePcm } from './wav.ts';

const MAX_WAIT_MS = 2_500;

/** Batch second opinions for the gold; not bake-off contestants (they never stream). */
export const BATCH_CONFIGS = {
  'scribe-v2-batch': { key: 'ELEVENLABS_API_KEY', usdPerHour: 0.22, model: 'scribe_v2' },
  'aai-batch': { key: 'ASSEMBLYAI_API_KEY', usdPerHour: 0.21, model: 'universal-3-5-pro' },
} as const;
type BatchId = keyof typeof BATCH_CONFIGS;

export async function record(values: Options): Promise<void> {
  const keys = await loadKeys(values.keys as string | undefined);
  const golds = await loadGolds();
  const calls = String(values.calls ?? golds.map((gold) => gold.call).join(',')).split(',');
  const net = createNodeNet();
  try {
    for (const id of String(values.configs ?? '')
      .split(',')
      .filter(Boolean)) {
      const config = configById(id);
      const status = configStatus(config, keys);
      if (status !== 'ready') {
        console.error(`${id}: ${status}, skipped`);
        continue;
      }
      for (const call of calls) {
        const gold = golds.find((candidate) => candidate.call === call);
        if (!gold) throw new Error(`no gold file for ${call}; run draft first`);
        const corpus = await loadCall(String(values.corpus), call);
        const only = values.only ? String(values.only).split(',') : undefined;
        const limit = values.limit ? Number(values.limit) : Infinity;
        const windows = streamWindows(corpus.pcm, allRegions(gold))
          .filter((window) => !only || only.some((prefix) => window.id.startsWith(prefix)))
          .slice(0, limit);
        if (!windows.length) continue;
        await spendGuard(
          plannedStreamMs(windows, MAX_WAIT_MS),
          Number(values['budget-min'] ?? 60),
          `${id} ${call}`,
        );
        const tap: { onMessage?: (raw: string) => void } = {};
        const tapped = tapNet(net, (raw) => tap.onMessage?.(raw));
        const recording = await streamCall({
          config: id,
          call,
          model: config.model,
          language: config.language,
          stt: config.create!(tapped, keys[config.key]!),
          utterances: windows,
          maxWaitMs: MAX_WAIT_MS,
          tap,
        });
        await mkdir(join(RUNS_DIR, id), { recursive: true });
        const file = join(RUNS_DIR, id, `${call}.json`);
        await writeJson(
          file,
          only && existsSync(file) ? merge(await readJsonFile(file), recording) : recording,
        );
        await logSpend({
          config: id,
          call,
          seconds: recording.streamedMs / 1000,
          at: recording.recordedAt,
        });
        console.error(
          `${id} ${call}: ${recording.utterances.length}/${windows.length} utterances, ${(recording.streamedMs / 1000).toFixed(1)} s streamed${recording.error ? `, ERROR ${recording.error}` : ''}`,
        );
      }
    }
  } finally {
    await net.close();
  }
}

export async function batch(values: Options): Promise<void> {
  const keys = await loadKeys(values.keys as string | undefined);
  const golds = await loadGolds();
  const net = createNodeNet();
  try {
    for (const id of String(values.configs ?? '')
      .split(',')
      .filter(Boolean) as BatchId[]) {
      const spec = BATCH_CONFIGS[id];
      if (!spec) throw new Error(`unknown batch config ${id}`);
      const key = keys[spec.key];
      if (!key) {
        console.error(`${id}: pending key, skipped`);
        continue;
      }
      for (const gold of golds) {
        const corpus = await loadCall(String(values.corpus), gold.call);
        const regions = allRegions(gold);
        const joined = compress(
          regions.map((utterance) => ({
            id: utterance.id,
            pcm: slicePcm(corpus.pcm, utterance.audioStartMs, utterance.audioEndMs),
          })),
        );
        const audioMs = (joined.pcm.samples.length / joined.pcm.sampleRate) * 1000;
        await spendGuard(audioMs, Number(values['budget-min'] ?? 60), `${id} ${gold.call}`);
        const out: BatchRecording = {
          config: id,
          call: gold.call,
          model: spec.model,
          recordedAt: new Date().toISOString(),
          audioMs,
          utterances: [],
        };
        try {
          const result =
            id === 'aai-batch'
              ? await assemblyAiBatch(net, key, joined.pcm)
              : await scribeBatch(net, key, joined.pcm, {
                  model: 'scribe_v2',
                  keyterms: TRAVEL_KEYTERMS,
                });
          if (result.language) out.language = result.language;
          const texts = wordsByUtterance(result.words, joined.offsetsMs, joined.lengthsMs);
          out.utterances = regions.map((utterance, index) => ({
            id: utterance.id,
            text: texts[index]!,
          }));
        } catch (error) {
          out.error = error instanceof Error ? error.message : String(error);
        }
        await mkdir(join(RUNS_DIR, id), { recursive: true });
        await writeJson(join(RUNS_DIR, id, `${gold.call}.json`), out);
        await logSpend({
          config: id,
          call: gold.call,
          seconds: audioMs / 1000,
          at: out.recordedAt,
        });
        console.error(
          `${id} ${gold.call}: ${(audioMs / 1000).toFixed(1)} s${out.error ? `, ERROR ${out.error}` : ''}`,
        );
      }
    }
  } finally {
    await net.close();
  }
}
