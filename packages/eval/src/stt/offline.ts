// The offline commands: segment the calls, gather every run's transcripts into the gold files,
// score the runs, and say which configurations can run. None of them contacts a provider.
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readKeys } from '../audio/stt-configs.ts';
import { STT_CONFIGS, configStatus } from './configs.ts';
import { SEGMENTATION, loadCall } from './corpus.ts';
import { allRegions, parseGold, type GoldCall } from './gold.ts';
import { BATCH_CONFIGS } from './live.ts';
import { liveCallSummary } from './live-call.ts';
import { formatReport } from './report.ts';
import { finalText } from './hypothesis.ts';
import { summarize } from './score.ts';
import {
  GOLD_DIR,
  isStream,
  loadGolds,
  loadRuns,
  readJsonFile,
  writeJson,
  type Options,
} from './store.ts';
import type { StreamRecording } from './stream.ts';
import type { BatchRecording } from './batch.ts';

export async function draft(values: Options): Promise<void> {
  await mkdir(GOLD_DIR, { recursive: true });
  for (const call of String(values.calls ?? 'call7,call8').split(',')) {
    const corpus = await loadCall(String(values.corpus), call);
    const file = join(GOLD_DIR, `${call}.json`);
    console.error(
      `${call}: ${corpus.drafts.length} utterances, alignment ${JSON.stringify(corpus.alignment)}`,
    );
    const prefix = call.replace(/^call/, 'c');
    const unheard = corpus.unheard.map((turn, index) => ({
      id: `${prefix}-n${String(index + 1).padStart(2, '0')}`,
      startMs: turn.audioStartMs + corpus.alignment.offsetMs,
      endMs: turn.audioEndMs + corpus.alignment.offsetMs,
      audioStartMs: turn.audioStartMs,
      audioEndMs: turn.audioEndMs,
      productionTurnIds: [turn.turn.turnId],
      productionText: turn.turn.text ?? '',
      candidates: {},
      note: 'the live call opened a user turn here, but the caller track is near-silent',
    }));
    if (existsSync(file)) {
      // An existing gold keeps its work; only regions it lacks are added.
      const gold = parseGold(await readJsonFile(file));
      const known = new Set(allRegions(gold).map((region) => region.id));
      const added = unheard.filter((region) => !known.has(region.id));
      gold.nonSpeech.push(...added);
      await writeJson(file, gold);
      console.error(`${file} exists; added ${added.length} unheard-turn regions`);
      continue;
    }
    const gold: GoldCall = {
      call,
      callId: corpus.log.callId,
      units: 'ms',
      offsetMs: corpus.alignment.offsetMs,
      audio: `${call}-caller.wav`,
      method: 'draft: segmentation and alignment only; no region transcribed yet',
      alignment: corpus.alignment,
      segmentation: { ...SEGMENTATION },
      utterances: [],
      nonSpeech: corpus.drafts
        .map((utterance) => ({
          id: utterance.id,
          startMs: utterance.startMs,
          endMs: utterance.endMs,
          audioStartMs: utterance.audioStartMs,
          audioEndMs: utterance.audioEndMs,
          productionTurnIds: utterance.productionTurnIds,
          productionText: utterance.productionFinals.map((final) => final.text).join(' '),
          candidates: {},
          note: 'draft: not transcribed yet',
        }))
        .concat(unheard),
      needsFounderReview: [],
    };
    await writeJson(file, gold);
  }
}

export async function candidates(): Promise<void> {
  const runs = await loadRuns();
  for (const gold of await loadGolds()) {
    for (const utterance of allRegions(gold)) {
      const found: Record<string, string> = {};
      for (const run of runs.filter((candidate) => candidate.call === gold.call)) {
        const recorded = run.utterances.find((candidate) => candidate.id === utterance.id) as
          StreamRecording['utterances'][number] | BatchRecording['utterances'][number] | undefined;
        if (!recorded) continue;
        found[run.config] = 'text' in recorded ? recorded.text : finalText(recorded);
      }
      utterance.candidates = found;
    }
    await writeJson(join(GOLD_DIR, `${gold.call}.json`), gold);
  }
}

export async function score(values: Options): Promise<void> {
  const golds = await loadGolds();
  const keys = await readKeys(values.keys as string | undefined);
  const runs = (await loadRuns()).filter(isStream);
  const wanted = values.configs ? String(values.configs).split(',') : STT_CONFIGS.map((c) => c.id);
  const configs = STT_CONFIGS.filter((config) => wanted.includes(config.id));
  const recorded = configs.filter((config) => runs.some((run) => run.config === config.id));
  const summaries = [
    liveCallSummary(
      STT_CONFIGS.find((config) => config.production)!,
      golds,
    ),
    ...recorded.map((config) => summarize(config, golds, runs)),
  ];
  const report = formatReport({
    summaries,
    configs: configs
      .filter((config) => !recorded.includes(config))
      .map((config) => ({ config, status: configStatus(config, keys) })),
    golds,
  });
  if (values.json)
    await writeJson(
      String(values.json),
      summaries.map(({ scores: _scores, ...summary }) => summary),
    );
  console.log(report);
}

export async function status(values: Options): Promise<void> {
  const keys = await readKeys(values.keys as string | undefined);
  for (const config of STT_CONFIGS)
    console.log(`${config.id.padEnd(26)} ${configStatus(config, keys).padEnd(15)} ${config.label}`);
  for (const [id, spec] of Object.entries(BATCH_CONFIGS))
    console.log(
      `${id.padEnd(26)} ${(keys[spec.key] ? 'ready' : 'pending key').padEnd(15)} batch ${spec.model} (gold only)`,
    );
}
