import { performance } from 'node:perf_hooks';
import {
  bytesPerSecond,
  type AudioFormat,
  type InferenceStreamEvent,
  type SttEvent,
} from '@winsendotai/ovo-contracts';
import type { InferenceActivitySource } from '@winsendotai/ovo-plugin-kit';

type Finish = (
  outcome: 'succeeded' | 'failed' | 'timeout' | 'unknown',
  payload?: Record<string, unknown>,
) => boolean;

/** Thirty seconds of 20 ms frames; a caller's last word is never older than that at end-of-turn. */
const MAX_CHECKPOINTS = 1_500;

/**
 * Reconstructs the provider's endpointing wait: from the moment the audio holding the caller's
 * last word was handed to speech recognition until the provider signalled end-of-turn. Word end
 * times are relative to the first audio written to the session, so the clock counts written audio.
 * Audio flushed from the pre-connection buffer is stamped when written, not when captured, so a
 * turn spoken before recognition was ready under-reports its wait.
 */
export class EndpointClock {
  private audioMs = 0;
  private readonly written: { endMs: number; at: number }[] = [];
  private lastWordEndMs?: number;

  constructor(
    private readonly format: AudioFormat,
    private readonly now: () => number = () => performance.now(),
  ) {}

  wrote(bytes: number): void {
    this.audioMs += (bytes / bytesPerSecond(this.format)) * 1_000;
    this.written.push({ endMs: this.audioMs, at: this.now() });
    if (this.written.length > MAX_CHECKPOINTS) this.written.shift();
  }

  observe(event: SttEvent, record: (ms: number, payload: Record<string, unknown>) => void): void {
    if (event.type === 'transcript') {
      const words = event.segment.words;
      const end = words?.length
        ? Math.max(...words.map((word) => word.endMs))
        : event.segment.endMs;
      if (end !== undefined && Number.isFinite(end)) this.lastWordEndMs = end;
      return;
    }
    if (event.type !== 'end-of-turn' || event.eager || this.lastWordEndMs === undefined) return;
    const lastWordEndMs = this.lastWordEndMs;
    this.lastWordEndMs = undefined;
    const heard = this.written.find((checkpoint) => checkpoint.endMs >= lastWordEndMs);
    if (!heard) return;
    record(Math.max(0, this.now() - heard.at), {
      lastWordEndMs,
      audioWrittenMs: Math.round(this.audioMs),
    });
  }
}

/**
 * N3: each web search the provider runs inside an inference step, from the provider streaming the
 * call to its result, as a `web_search` stage with the action and how many sources it returned.
 * A search its request abandoned ends `unknown`.
 */
export function timeWebSearches(source: InferenceActivitySource, begin: () => Finish): () => void {
  const open = new Map<string, Finish>();
  return source.observeActivity((activity) => {
    if (activity.tool !== 'web_search') return;
    if (activity.phase === 'started') {
      open.set(activity.id, begin());
      return;
    }
    const finish = open.get(activity.id);
    open.delete(activity.id);
    finish?.(activity.outcome === 'cancelled' ? 'unknown' : activity.outcome, {
      action: activity.action ?? null,
      results: activity.results ?? null,
    });
  });
}

/** Times the first text or tool call of an inference stream, without changing the stream. */
export async function* timeFirstToken(
  events: AsyncIterable<InferenceStreamEvent>,
  begin: () => Finish,
): AsyncIterable<InferenceStreamEvent> {
  let finish: Finish | undefined = begin();
  try {
    for await (const event of events) {
      if (
        finish &&
        ((event.kind === 'text-delta' && event.delta.trim()) || event.kind === 'tool')
      ) {
        finish('succeeded');
        finish = undefined;
      }
      yield event;
    }
  } catch (error) {
    finish?.(
      !(error instanceof DOMException)
        ? 'failed'
        : error.name === 'TimeoutError'
          ? 'timeout'
          : 'unknown',
    );
    finish = undefined;
    throw error;
  } finally {
    // A stream that ends or is abandoned before any token has no first-token time.
    finish?.('unknown');
  }
}
