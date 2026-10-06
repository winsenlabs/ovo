import type { Logger, UsageSink } from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type {
  PostgresSpeechPrerenderQueue,
  PrerenderJob,
  PrerenderReason,
} from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { SpeechPrerenderOptions } from './speech-cache-env.ts';
import { createPrerenderMeter } from './speech-cache-meter.ts';
import { warmReleaseClips, type WarmResult } from './speech-cache-prerender.ts';
import { PrerenderSkipError, type ReleaseSpeech } from './speech-cache-release-tts.ts';
import { releaseKey, ROUTED_REFRESH_MS, syncRoutedReleases } from './speech-cache-routed.ts';
import type { SpeechClipStore, WorkerSpeechClipCache } from './speech-cache-tiers.ts';

type Queue = Pick<PostgresSpeechPrerenderQueue, 'claim' | 'finish' | 'routedReleases'>;

export interface PrerenderServiceInput {
  cache: WorkerSpeechClipCache;
  clips?: SpeechClipStore & { collectGarbage(days: number): Promise<unknown> };
  queue?: Queue;
  options: SpeechPrerenderOptions;
  workerId: string;
  releases: { getRelease(workspaceId: string, id: string): Promise<ReleaseRecord | undefined> };
  openSpeech(release: ReleaseRecord, usage: UsageSink): Promise<ReleaseSpeech>;
  ledger?: Pick<CostLedgerService, 'recordUsage'>;
  log?: Logger;
}

const GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps this worker's speech clips warm (TTS-9): routed releases at start, a release's first call
 * on this worker, and publishes queued by the API (claimed by any one worker, which renders the
 * missing lines into the durable tier for everyone). Warming the same release twice on one worker
 * is skipped; every render is metered as pre-render usage.
 */
export class SpeechPrerenderService {
  private readonly controller = new AbortController();
  private readonly local = new Map<string, { release: ReleaseRecord; reason: PrerenderReason }>();
  private readonly warmed = new Set<string>();
  private readonly log: Logger;
  private wake?: () => void;
  private running?: Promise<void>;
  private unsubscribe?: () => void;
  private lastGc = 0;
  private lastRouted = 0;
  private busy = false;

  constructor(private readonly input: PrerenderServiceInput) {
    this.log = input.log ?? createLogger({ service: 'worker', component: 'speech-prerender' });
  }

  start(): void {
    if (this.running) return;
    this.unsubscribe = this.input.cache.onSession((release) =>
      this.requestWarm(release, 'first-call'),
    );
    this.running = this.loop().catch((error: unknown) =>
      this.log.error('speech_prerender_loop_failed', errorFields(error)),
    );
  }

  requestWarm(release: ReleaseRecord, reason: PrerenderReason): void {
    const key = releaseKey(release);
    if (!release.config.speechCache?.enabled || this.warmed.has(key) || this.local.has(key)) return;
    this.local.set(key, { release, reason });
    this.wake?.();
  }

  /** Resolves once every queued local warm has run; for tests and orderly shutdown. */
  async idle(): Promise<void> {
    while (this.local.size || this.busy) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.controller.abort(new DOMException('speech prerender closed', 'AbortError'));
    this.wake?.();
    await this.running;
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  private async loop(): Promise<void> {
    await this.queueRoutedReleases();
    while (!this.signal.aborted) {
      const next = this.local.entries().next().value;
      this.busy = true;
      try {
        if (next) {
          this.local.delete(next[0]);
          this.warmed.add(next[0]);
          await this.warm(next[1].release, next[1].reason).catch((error: unknown) =>
            this.failed(next[1].release, error),
          );
          continue;
        }
        const job = await this.claim();
        if (job) {
          await this.runJob(job);
          continue;
        }
        await this.refreshRouted();
        await this.collectGarbage();
      } finally {
        this.busy = false;
      }
      await this.sleep(this.input.options.pollMs);
    }
  }

  private async queueRoutedReleases(): Promise<void> {
    if (!this.input.queue) return;
    this.lastRouted = Date.now();
    await syncRoutedReleases({
      queue: this.input.queue,
      cache: this.input.cache,
      releases: this.input.releases,
      warmed: this.warmed,
      requestWarm: (release) => this.requestWarm(release, 'worker-start'),
    }).catch((error: unknown) =>
      this.log.warn('speech_prerender_routed_lookup_failed', errorFields(error)),
    );
  }

  private async refreshRouted(): Promise<void> {
    const every = this.input.options.routedRefreshMs ?? ROUTED_REFRESH_MS;
    if (Date.now() - this.lastRouted >= every) await this.queueRoutedReleases();
  }

  private async claim(): Promise<PrerenderJob | undefined> {
    try {
      return await this.input.queue?.claim(this.input.workerId, this.input.options.leaseMs);
    } catch (error) {
      this.log.warn('speech_prerender_claim_failed', errorFields(error));
      return undefined;
    }
  }

  private async runJob(job: PrerenderJob): Promise<void> {
    const finish = (result: Partial<WarmResult> & { state: WarmResult['state'] }) =>
      this.input.queue!.finish({
        workspaceId: job.workspaceId,
        releaseId: job.releaseId,
        workerId: this.input.workerId,
        state: result.state,
        total: result.total ?? job.total,
        perCall: result.perCall ?? job.perCall,
        inventorySha256: result.inventorySha256,
        detail: result.detail,
      });
    try {
      const release = await this.input.releases.getRelease(job.workspaceId, job.releaseId);
      if (!release) return await finish({ state: 'skipped', detail: 'release not found' });
      const result = await this.warm(release, job.reason);
      this.warmed.add(releaseKey(release));
      await finish(result);
    } catch (error) {
      // An interrupted job keeps its lease; another worker reclaims it once the lease expires.
      if (this.signal.aborted) return;
      this.log.warn('speech_prerender_job_failed', {
        releaseId: job.releaseId,
        ...errorFields(error),
      });
      await finish({ state: 'failed', detail: errorFields(error).error }).catch(
        (finishError: unknown) =>
          this.log.error('speech_prerender_finish_failed', errorFields(finishError)),
      );
    }
  }

  private async warm(release: ReleaseRecord, reason: PrerenderReason): Promise<WarmResult> {
    if (!release.config.speechCache?.enabled)
      return skipped('speech cache is not enabled for this release');
    const meter = createPrerenderMeter(release, this.input.ledger, this.log);
    let speech: ReleaseSpeech;
    try {
      speech = await this.input.openSpeech(release, meter.sink);
    } catch (error) {
      if (error instanceof PrerenderSkipError) return skipped(error.message);
      throw error;
    }
    let result: WarmResult;
    try {
      result = await warmReleaseClips(
        {
          release,
          tts: speech.tts,
          filters: speech.filters,
          onUsage: meter.sink,
          signal: this.signal,
        },
        { cache: this.input.cache, store: this.input.clips, options: this.input.options },
      );
    } finally {
      await speech.close();
    }
    const metered = await meter.flush();
    this.log.info('speech_prerender_finished', {
      releaseId: release.id,
      reason,
      state: result.state,
      total: result.total,
      existing: result.existing,
      rendered: result.rendered,
      failed: result.failed,
      deferred: result.deferred,
      usageRecorded: metered.recorded,
      usageUnpriced: metered.unpriced,
    });
    return result;
  }

  private failed(release: ReleaseRecord, error: unknown): void {
    if (this.signal.aborted) return;
    this.log.warn('speech_prerender_warm_failed', { releaseId: release.id, ...errorFields(error) });
  }

  private async collectGarbage(): Promise<void> {
    if (!this.input.clips || Date.now() - this.lastGc < GC_INTERVAL_MS) return;
    this.lastGc = Date.now();
    try {
      await this.input.clips.collectGarbage(this.input.options.retentionDays);
    } catch (error) {
      this.log.warn('speech_clip_gc_failed', errorFields(error));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}

function skipped(detail: string): WarmResult {
  return {
    state: 'skipped',
    total: 0,
    existing: 0,
    rendered: 0,
    failed: 0,
    deferred: 0,
    perCall: 0,
    detail,
  };
}
