import type { AudioFormat } from '@winsendotai/ovo-contracts';

export interface IngressLimits {
  maxFrames: number;
  maxBytes: number;
  preSttBufferMs: number;
  /** Newest audio kept when a backlog overflows; older audio is dropped. Defaults to 3 s. */
  keepMs?: number;
  /** Connect attempts after a retryable mid-call STT failure. Defaults to 2. */
  reconnectAttempts?: number;
}

export type QueuedIngress =
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'endpoint'; resolve: () => void; reject: (reason: unknown) => void };

export const DEFAULT_KEEP_MS = 3_000;

/** Carrier audio and endpoint requests waiting for STT, with their frame and byte accounting. */
export class IngressBacklog {
  readonly items: QueuedIngress[] = [];
  frames = 0;
  bytes = 0;
  overflows = 0;
  droppedFrames = 0;

  constructor(
    private readonly limits: IngressLimits,
    private readonly bytesPerMs: number,
  ) {}

  /**
   * Makes room for `incoming` bytes. Over a limit, the oldest queued audio is dropped down to the
   * newest `keepMs`: a caller who spoke while STT was connecting loses the start of the utterance
   * rather than the call. Before STT connects, and while it reconnects, the limit is the pre-STT
   * span. Returns what was dropped, or false when even an empty backlog cannot hold the frame.
   */
  admit(incoming: number, connected: boolean): { frames: number; bytes: number } | false {
    const byteLimit = connected
      ? this.limits.maxBytes
      : Math.min(this.limits.maxBytes, this.bytesPerMs * this.limits.preSttBufferMs);
    const fits = () =>
      this.frames + 1 <= this.limits.maxFrames && this.bytes + incoming <= byteLimit;
    if (fits()) return { frames: 0, bytes: 0 };
    const keepMs = this.limits.keepMs ?? DEFAULT_KEEP_MS;
    const keepBytes = Math.min(byteLimit, this.bytesPerMs * keepMs);
    const keepFrames = Math.floor(this.limits.maxFrames / 2);
    const dropped = { frames: 0, bytes: 0 };
    while (!fits() || this.bytes > keepBytes || this.frames > keepFrames) {
      // Endpoints stay, so a requested ForceEndpoint still follows the audio that remains.
      const index = this.items.findIndex((item) => item.kind === 'audio');
      if (index < 0) break;
      const [item] = this.items.splice(index, 1) as [{ kind: 'audio'; bytes: Uint8Array }];
      this.frames--;
      this.bytes -= item.bytes.length;
      dropped.frames++;
      dropped.bytes += item.bytes.length;
    }
    this.overflows++;
    this.droppedFrames += dropped.frames;
    return fits() && dropped;
  }

  push(bytes: Uint8Array): void {
    this.items.push({ kind: 'audio', bytes });
    this.frames++;
    this.bytes += bytes.length;
  }

  /** Puts audio back at the front, ahead of everything that arrived since. */
  replay(frames: readonly Uint8Array[]): void {
    for (const bytes of [...frames].reverse()) {
      this.items.unshift({ kind: 'audio', bytes });
      this.frames++;
      this.bytes += bytes.length;
    }
  }

  shift(): QueuedIngress | undefined {
    const item = this.items.shift();
    if (item?.kind === 'audio') {
      this.frames--;
      this.bytes = Math.max(0, this.bytes - item.bytes.length);
    }
    return item;
  }

  /** Resolves pending endpoints; the call is ending and no provider will receive them. */
  clear(): void {
    for (const item of this.items) if (item.kind === 'endpoint') item.resolve();
    this.items.length = 0;
    this.frames = 0;
    this.bytes = 0;
  }
}

/**
 * Caller audio held while STT connects. The worker buffers the same span before the engine
 * exists, so a provider handshake (two attempts at the 6 s default connect deadline) loses none
 * of what the caller said; a longer configured deadline drops the oldest audio, not the call.
 */
export const DEFAULT_PRE_STT_BUFFER_MS = 15_000;
/** Carrier frames are at least this long; ingress frame capacity follows the pre-STT span. */
const MIN_CARRIER_FRAME_MS = 10;

/**
 * A configured limit below the pre-STT span would refuse the burst the worker replays once the
 * session opens, so capacity never drops below it.
 */
export function ingressLimitsFor(
  config: { maxIngressFrames?: number; maxIngressBytes?: number; preSttBufferMs?: number },
  format: AudioFormat,
): IngressLimits {
  const preSttBufferMs = config.preSttBufferMs ?? DEFAULT_PRE_STT_BUFFER_MS;
  const bytesPerSecond = format.sampleRate * (format.encoding === 'pcm_s16le' ? 2 : 1);
  return {
    maxFrames: Math.max(
      config.maxIngressFrames ?? 0,
      Math.ceil(preSttBufferMs / MIN_CARRIER_FRAME_MS),
    ),
    maxBytes: Math.max(
      config.maxIngressBytes ?? 512 * 1024,
      (bytesPerSecond * preSttBufferMs) / 1000,
    ),
    preSttBufferMs,
  };
}
