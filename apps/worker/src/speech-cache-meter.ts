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

/**
 * What metering needs: `recordUsage`, and, to find the FX a non-INR card's reference left out,
 * the card and FX reads (optional; without them such a usage fails to price, as before).
 */
export type PrerenderLedger = Pick<CostLedgerService, 'recordUsage'> &
  Partial<Pick<CostLedgerService, 'getPriceCard' | 'getFxVersion'>>;

type PriceReference = NonNullable<ReleaseRecord['config']['costPolicy']>['priceCards'][string];
type FxReference = { id: string; version: string };

/**
 * The FX a pre-render charge converts with: its own reference's; else, for a non-INR card the
 * release references without one, the one FX version the release's cost policy references that
 * converts that currency to INR. 2026-10-07: release eb35ee47's TTS card had no FX of its
 * own, so every pre-render charge failed with "Non-INR pricing requires an explicit immutable FX
 * version" although the release's other USD cards named usd-inr. Ambiguous or absent: undefined.
 */
async function releaseFx(
  release: Pick<ReleaseRecord, 'config'>,
  reference: PriceReference,
  ledger: PrerenderLedger,
): Promise<FxReference | undefined> {
  if (reference.fxId && reference.fxVersion)
    return { id: reference.fxId, version: reference.fxVersion };
  if (!ledger.getPriceCard || !ledger.getFxVersion) return undefined;
  const card = await ledger.getPriceCard(reference.id, reference.version);
  if (!card || card.currency === 'INR') return undefined;
  const candidates = new Map<string, FxReference>();
  for (const other of Object.values(release.config.costPolicy?.priceCards ?? {}))
    if (other.fxId && other.fxVersion)
      candidates.set(JSON.stringify([other.fxId, other.fxVersion]), {
        id: other.fxId,
        version: other.fxVersion,
      });
  const matching: FxReference[] = [];
  for (const candidate of candidates.values()) {
    const fx = await ledger.getFxVersion(candidate.id, candidate.version);
    if (fx?.baseCurrency === card.currency && fx.quoteCurrency === 'INR') matching.push(candidate);
  }
  return matching.length === 1 ? matching[0] : undefined;
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
  ledger: PrerenderLedger | undefined,
  log: Logger,
): PrerenderMeter {
  const writes: Promise<void>[] = [];
  const summary: PrerenderMeterSummary = { recorded: 0, unpriced: [], failed: 0 };
  // One lookup per meter key and release, not one per rendered line.
  const fxByKey = new Map<string, Promise<FxReference | undefined>>();
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
      if (!fxByKey.has(key)) fxByKey.set(key, releaseFx(release, card, ledger));
      const fx = await fxByKey.get(key)!;
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
        fx,
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
