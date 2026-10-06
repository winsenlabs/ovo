import type { SpeechSegment } from '@winsendotai/ovo-contracts';
import type { PreparedAudio } from './session-graph-speech-output.ts';

/**
 * Where one segment's audio came from (TTS-11). `bypass` is live speech the cache may not hold;
 * `template` is a line rendered for this call alone from its variables (TTS-10).
 */
export type SpeechCacheSource =
  'pinned' | 'durable' | 'l1' | 'template' | 'miss' | 'coalesced' | 'bypass';

/** The session's audit sink; the worker passes `telemetry.audit`. Payloads never carry text. */
export interface SpeechCacheObserver {
  audit(kind: string, payload: Record<string, unknown>): void;
}

const SOURCES: readonly SpeechCacheSource[] = [
  'pinned',
  'durable',
  'l1',
  'template',
  'miss',
  'coalesced',
  'bypass',
];
const CACHED: ReadonlySet<SpeechCacheSource> = new Set([
  'pinned',
  'durable',
  'l1',
  'template',
  'coalesced',
]);

/** Per-segment cache evidence plus a per-call summary, so hit rate and savings are measurable. */
export class SpeechCacheTelemetry {
  private readonly counts = new Map<SpeechCacheSource, number>();
  private cachedBytes = 0;
  private liveBytes = 0;
  private summarized = false;

  constructor(
    private readonly observer?: SpeechCacheObserver,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Wraps one segment's audio; the event is written once, when the audio ends or is dropped. */
  track(
    segment: SpeechSegment,
    source: SpeechCacheSource | (() => SpeechCacheSource),
    prepared: PreparedAudio,
  ): PreparedAudio {
    const startedAt = this.now();
    const sourceOf = typeof source === 'function' ? source : () => source;
    let bytes = 0;
    let firstByteMs: number | null = null;
    let done = false;
    const finish = (outcome: 'completed' | 'cancelled' | 'failed') => {
      if (done) return;
      done = true;
      this.record(segment, sourceOf(), bytes, firstByteMs, outcome);
    };
    const now = this.now;
    const audio = (async function* () {
      let outcome: 'completed' | 'cancelled' | 'failed' = 'cancelled';
      try {
        for await (const chunk of prepared.audio) {
          if (firstByteMs === null && chunk.byteLength) firstByteMs = now() - startedAt;
          bytes += chunk.byteLength;
          yield chunk;
        }
        outcome = 'completed';
      } catch (error) {
        outcome = 'failed';
        throw error;
      } finally {
        finish(outcome);
      }
    })();
    return {
      ...prepared,
      audio,
      cancel: () => {
        prepared.cancel();
        finish('cancelled');
      },
    };
  }

  /** Written when the session's output is disposed, ahead of `session.ended`. */
  summary(): void {
    if (this.summarized || !this.counts.size) return;
    this.summarized = true;
    const segments = [...this.counts.values()].reduce((sum, count) => sum + count, 0);
    const cacheable = segments - (this.counts.get('bypass') ?? 0);
    const hits = SOURCES.filter((source) => CACHED.has(source)).reduce(
      (sum, source) => sum + (this.counts.get(source) ?? 0),
      0,
    );
    this.observer?.audit('speech.cache.summary', {
      segments,
      sources: Object.fromEntries(SOURCES.map((source) => [source, this.counts.get(source) ?? 0])),
      cachedBytes: this.cachedBytes,
      liveBytes: this.liveBytes,
      hitRate: cacheable ? Math.round((hits / cacheable) * 1000) / 1000 : null,
    });
  }

  private record(
    segment: SpeechSegment,
    source: SpeechCacheSource,
    bytes: number,
    msToFirstByte: number | null,
    outcome: 'completed' | 'cancelled' | 'failed',
  ): void {
    this.counts.set(source, (this.counts.get(source) ?? 0) + 1);
    if (CACHED.has(source)) this.cachedBytes += bytes;
    else this.liveBytes += bytes;
    this.observer?.audit('speech.cache', {
      segmentId: segment.id,
      responseEpoch: segment.epoch,
      speechKind: segment.kind,
      source,
      bytes,
      msToFirstByte: msToFirstByte === null ? null : Math.round(msToFirstByte),
      outcome,
    });
  }
}
