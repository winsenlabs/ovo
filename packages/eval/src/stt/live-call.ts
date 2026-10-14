// The baseline row: what the live calls themselves heard, scored like a configuration.
import type { SttConfig } from './configs.ts';
import { allRegions, type GoldCall } from './gold.ts';
import { summarize, type ConfigSummary } from './score.ts';
import type { StreamRecording } from './stream.ts';

/**
 * What the live call itself got: the production STT's finals for each region (`productionText`)
 * scored like a configuration. Its latency and cost are not known from the gold, so they are null
 * and zero; its finals were matched to regions by arrival time.
 */
export function liveCallSummary(production: SttConfig, golds: readonly GoldCall[]): ConfigSummary {
  const recordings: StreamRecording[] = golds.map((gold) => ({
    config: 'live-call',
    call: gold.call,
    model: production.model,
    language: production.language,
    recordedAt: '',
    streamedMs: 0,
    sessionMs: 0,
    usage: [],
    utterances: allRegions(gold).map((region) => ({
      id: region.id,
      startMs: 0,
      speechEndMs: 0,
      commitsAtMs: [],
      languages: [],
      events: region.productionText
        ? [{ atMs: 0, kind: 'final' as const, segmentId: '0', text: region.productionText }]
        : [],
    })),
  }));
  return {
    ...summarize(
      { ...production, id: 'live-call', label: 'The live calls (Scribe auto)' },
      golds,
      recordings,
    ),
    timeToFinalP50Ms: null,
    timeToFinalP90Ms: null,
    noFinal: 0,
    usdPerMinute: production.price.usdPerHour / 60,
  };
}
