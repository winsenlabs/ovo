import type { Clock, SynthesisInput, UsageSink } from '@winsendotai/ovo-contracts';
import { abortError } from '@winsendotai/ovo-plugin-kit';
import type { MultiContextConnection } from './connection.ts';

/** Renders one segment over HTTP (its own request and meter). */
export type HttpRender = (
  text: string,
  signal: AbortSignal,
  onUsage: UsageSink,
) => AsyncIterable<Uint8Array>;

export interface ReplyInit {
  /** The pooled socket and its context slot; undefined renders every segment over HTTP. */
  socket?: { connection: MultiContextConnection; release: () => void };
  contextId: string;
  requestId: string;
  input: Omit<SynthesisInput, 'text'>;
  /** voice_settings and friends, sent once on the context's initialising frame. */
  opening: Record<string, unknown>;
  limit: number;
  clock: Pick<Clock, 'now' | 'setTimeout'>;
  render: HttpRender;
  /** Replay over HTTP after the socket drops (binding `httpFallback`). */
  replay: boolean;
  /** No alignment and no audio for this long ends the oldest flushed segment (safety net). */
  quietMs: number;
}

/** Spoken characters: counted on both sides, so punctuation the provider drops cannot skew it. */
const SPOKEN = /[\p{L}\p{M}\p{N}]/gu;
export const spokenCount = (text: string): number => text.match(SPOKEN)?.length ?? 0;

/** What is left after the first `aligned` spoken characters, from the start of the unheard word. */
export function unspokenText(text: string, aligned: number): string {
  if (aligned <= 0) return text;
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[\p{L}\p{M}\p{N}]/u.test(text[index]!)) continue;
    if (++seen <= aligned) continue;
    const start = text.lastIndexOf(' ', index) + 1;
    return text.slice(start).trim();
  }
  return '';
}

/** One segment of a reply: its text, how far the provider has aligned it, and its audio. */
export interface Part {
  text: string;
  spoken: number;
  /** Spoken characters the provider has aligned to audio so far. */
  aligned: number;
  received: number;
  queue: Uint8Array[];
  done: boolean;
  dropped: boolean;
  error?: Error;
  /** Characters sent on the socket, metered once the segment is done; 0 once HTTP renders it. */
  socketChars: number;
  sentAt: number;
  controller: AbortController;
  wake?: () => void;
}

/** The segment's audio as its consumer reads it; aborting `signal` drops the rest of it. */
export async function* partAudio(part: Part, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const drop = () => {
    part.dropped = true;
    part.queue.length = 0;
    part.controller.abort(
      signal.aborted ? abortError(signal) : new DOMException('segment dropped', 'AbortError'),
    );
    part.wake?.();
  };
  if (signal.aborted) drop();
  else signal.addEventListener('abort', drop, { once: true });
  if (!part.spoken) part.done = true;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (part.queue.length) {
        yield part.queue.shift()!;
        continue;
      }
      if (part.error) throw part.error;
      if (part.done) return;
      await new Promise<void>((resolve) => (part.wake = resolve));
      part.wake = undefined;
    }
  } finally {
    signal.removeEventListener('abort', drop);
    // A consumer that stops early hands the rest of this segment's audio to nobody.
    if (!part.done) drop();
  }
}
