import type { TtsReply } from '@winsendotai/ovo-contracts';
import { RumikTtsError } from './errors.ts';

/** Queues one segment of a reply; the reply's own signal ends it quietly. */
export type SegmentQueue = (
  text: string,
  signal: AbortSignal,
  quiet: AbortSignal,
) => AsyncIterable<Uint8Array>;

/**
 * An agent reply on Rumik (R4). Silk has no context to append to, so each segment is its own
 * generation on the session's queue: segment N+1 goes out only after segment N's `done`, and each
 * one pays Rumik's per-request time to first byte (the known latency risk; see the README).
 * `close()` (barge-in, or the reply went quiet) ends every unfinished segment at once: the queued
 * ones never reach Rumik, the running one is cancelled and its late audio dropped.
 */
export class RumikReply implements TtsReply {
  private readonly closed = new AbortController();
  private readonly offInput: () => void;

  constructor(
    private readonly queue: SegmentQueue,
    input: AbortSignal,
  ) {
    const close = () => this.closed.abort();
    input.addEventListener('abort', close, { once: true });
    this.offInput = () => input.removeEventListener('abort', close);
    if (input.aborted) close();
  }

  segment(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.closed.signal.aborted) throw new RumikTtsError('Rumik TTS reply is closed', false);
    return this.queue(text, signal, this.closed.signal);
  }

  async close(): Promise<void> {
    this.offInput();
    this.closed.abort();
  }
}
