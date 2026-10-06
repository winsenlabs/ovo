import { meterKey, type Logger, type UsageMeter, type UsageSink } from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

/** Pre-render usage is the release's, not any call's: it lands under this ledger session id. */
export const prerenderSessionId = (releaseId: string) => `prerender:${releaseId}`;
export const PRERENDER_SOURCE_EVENT = 'speech.prerender';

export interface PrerenderMeterSummary {
  recorded: number;
  /** Meter keys the release's cost policy has no price card for; logged, never dropped silently. */
  unpriced: string[];
  failed: number;
}

export interface PrerenderMeter {
  sink: UsageSink;
  flush(): Promise<PrerenderMeterSummary>;
}

/**
 * Meters pre-render synthesis to the workspace with a kind of its own: ledger session
 * `prerender:<releaseId>`, source event `speech.prerender`, activity `startup`, cache disposition
 * `generation`. A call that later plays the clip records no TTS usage for it.
 */
export function createPrerenderMeter(
  release: Pick<ReleaseRecord, 'id' | 'workspaceId' | 'config'>,
  ledger: Pick<CostLedgerService, 'recordUsage'> | undefined,
  log: Logger,
): PrerenderMeter {
  const writes: Promise<void>[] = [];
  const summary: PrerenderMeterSummary = { recorded: 0, unpriced: [], failed: 0 };
  const record = async (meter: UsageMeter) => {
    const key = meterKey(meter);
    const card = release.config.costPolicy?.priceCards[key];
    if (!ledger || !card) {
      if (!summary.unpriced.includes(key)) summary.unpriced.push(key);
      log.warn('speech_prerender_usage_unpriced', {
        releaseId: release.id,
        meterKey: key,
        quantity: meter.quantity,
        reason: ledger ? 'no-price-card' : 'no-ledger',
      });
      return;
    }
    try {
      await ledger.recordUsage({
        idempotencyKey: `prerender:${release.id}:${meter.requestId}:${meter.unit}`,
        workspaceId: release.workspaceId,
        sessionId: prerenderSessionId(release.id),
        provider: meter.provider,
        providerRequestId: meter.requestId,
        sourceKind: 'tts-generation',
        sourceEventType: PRERENDER_SOURCE_EVENT,
        sourceEventId: `${release.id}:${meter.requestId}`,
        activity: 'startup',
        cacheDisposition: 'generation',
        quantity: meter.quantity,
        unit: meter.unit,
        occurredAt: new Date().toISOString(),
        priceCard: { id: card.id, version: card.version },
        fx: card.fxId && card.fxVersion ? { id: card.fxId, version: card.fxVersion } : undefined,
      });
      summary.recorded += 1;
    } catch (error) {
      summary.failed += 1;
      log.error('speech_prerender_usage_write_failed', {
        releaseId: release.id,
        meterKey: key,
        ...errorFields(error),
      });
    }
  };
  return {
    sink: (meter) => {
      writes.push(record(meter));
    },
    async flush() {
      while (writes.length) await Promise.all(writes.splice(0));
      return { ...summary, unpriced: [...summary.unpriced] };
    },
  };
}
