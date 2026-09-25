import type {
  MediaDuplex,
  SessionInput,
  SpeechOutput,
  SpeechOutputResult,
  SpeechSegment,
  TextToSpeech,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import { bytesPerSecond } from '@winsendotai/ovo-contracts';
import { PrefetchBuffer } from './prefetch.ts';
import type { SpeechTimingSink } from './timing.ts';

type Reporter = (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
type Pending = {
  epoch: number;
  resolve: (result: SpeechOutputResult) => void;
  cancel: () => void;
  report?: Reporter;
};
type Prepared = { buffer: PrefetchBuffer; cancel: () => void };

/** V2 output: synthesis runs ahead while carrier writes remain strictly ordered. */
export class NativeStreamingSpeechOutput implements SpeechOutput {
  private readonly prepared = new Map<string, Prepared>();
  private readonly pending = new Map<string, Pending>();
  private sendTail: Promise<void> = Promise.resolve();
  private timing?: SpeechTimingSink;
  private readonly unsubs: (() => void)[];

  constructor(
    private readonly tts: TextToSpeech,
    private readonly media: MediaDuplex,
    private session: SessionInput | undefined,
    private readonly usage: UsageSink,
    private config: {
      voice?: string;
      markTimeoutMs?: number;
      maxPrefetchBytes?: number;
    } = {},
  ) {
    this.unsubs = [
      media.onPlayed((name) => this.acknowledge(name)),
      media.onClose(() => this.cancelAll()),
    ];
  }

  configureSession(session: SessionInput): void {
    this.session = session;
  }

  configure(options: { markTimeoutMs?: number; maxPrefetchBytes?: number }): void {
    this.config = {
      ...this.config,
      ...(options.markTimeoutMs === undefined ? {} : { markTimeoutMs: options.markTimeoutMs }),
      ...(options.maxPrefetchBytes === undefined
        ? {}
        : { maxPrefetchBytes: options.maxPrefetchBytes }),
    };
  }

  configureTiming(listener: SpeechTimingSink): void {
    this.timing = listener;
  }

  async prepare(segment: SpeechSegment, signal: AbortSignal): Promise<void> {
    if (this.prepared.has(segment.id)) return;
    if (!this.session) throw new Error('Native speech output has no session input');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const buffer = new PrefetchBuffer(this.config.maxPrefetchBytes ?? 262_144);
    this.prepared.set(segment.id, {
      buffer,
      cancel: () => {
        controller.abort(new DOMException('prefetch cancelled', 'AbortError'));
        signal.removeEventListener('abort', abort);
        buffer.end();
      },
    });
    void (async () => {
      try {
        let firstByte = true;
        const queueChunk = async (chunk: Uint8Array) => {
          if (firstByte && chunk.length) {
            firstByte = false;
            this.timing?.('tts-first-byte', segment);
          }
          await buffer.push(chunk, controller.signal);
        };
        const input = {
          sessionId: this.media.sessionId,
          format: this.media.format,
          language: this.session!.language,
          voice: this.config.voice,
          kind: segment.kind,
          signal: controller.signal,
          onUsage: this.usage,
        };
        let stream: AsyncIterable<Uint8Array>;
        if (this.tts.capabilities.incrementalText && this.tts.open) {
          const incremental = await this.tts.open(input);
          incremental.push(segment.text);
          incremental.flush();
          stream = incremental.audio;
          try {
            for await (const chunk of stream) await queueChunk(chunk);
          } finally {
            await incremental.close();
          }
        } else {
          stream = this.tts.synthesize({ ...input, text: segment.text });
          for await (const chunk of stream) await queueChunk(chunk);
        }
        buffer.end();
      } catch (error) {
        buffer.end(error);
      }
    })();
  }

  async play(
    segment: SpeechSegment,
    options: { signal: AbortSignal; report?: Reporter },
  ): Promise<SpeechOutputResult> {
    if (options.signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
    await this.prepare(segment, options.signal);
    const prior = this.sendTail;
    let release!: () => void;
    this.sendTail = new Promise<void>((resolve) => (release = resolve));
    const mark = segment.id + ':' + segment.epoch;
    try {
      await prior;
      options.signal.throwIfAborted();
      let reported = false;
      for await (const chunk of this.prepared.get(segment.id)!.buffer) {
        options.signal.throwIfAborted();
        if (!chunk.length) continue;
        await this.media.sendAudio(chunk, options.signal);
        if (!reported) {
          reported = true;
          this.timing?.('carrier-first-audio', segment);
          options.report?.('sent', 'estimated');
        }
      }
      options.signal.throwIfAborted();
      const ack = this.waitForMark(mark, segment.epoch, options.report);
      const abort = () => this.cancelMark(mark);
      options.signal.addEventListener('abort', abort, { once: true });
      try {
        await this.media.mark(mark, options.signal);
        release(); // segment N+1 sends immediately; this segment still waits for its mark
        return await ack;
      } finally {
        options.signal.removeEventListener('abort', abort);
      }
    } catch (error) {
      this.cancelMark(mark);
      release();
      if (options.signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      throw error;
    } finally {
      this.prepared.get(segment.id)?.cancel();
      this.prepared.delete(segment.id);
    }
  }

  async interrupt(epoch: number): Promise<void> {
    // A carrier may echo a flushed mark synchronously from clear().
    for (const [name, pending] of this.pending) if (pending.epoch === epoch) this.cancelMark(name);
    // Old synthesis may ignore abort and never release its send slot. A new epoch
    // waits for clear, then owns a fresh slot; the old play still checks abort
    // before every carrier write if its iterator eventually resumes.
    const cleared = this.media.clear();
    this.sendTail = cleared.catch(() => undefined);
    await cleared;
  }

  dispose(): void {
    this.cancelAll();
    for (const prepared of this.prepared.values()) prepared.cancel();
    this.prepared.clear();
    for (const unsub of this.unsubs) unsub();
  }

  private waitForMark(name: string, epoch: number, report?: Reporter): Promise<SpeechOutputResult> {
    return new Promise((resolve) => {
      const bufferedMs = (this.media.bufferedBytes / bytesPerSecond(this.media.format)) * 1000;
      const timer = setTimeout(
        () => {
          this.pending.delete(name);
          resolve({ state: 'completed', evidence: 'estimated' });
        },
        Math.ceil(bufferedMs + (this.config.markTimeoutMs ?? 15_000)),
      );
      timer.unref?.();
      this.pending.set(name, {
        epoch,
        resolve,
        report,
        cancel: () => clearTimeout(timer),
      });
    });
  }

  private acknowledge(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    pending.cancel();
    this.pending.delete(name);
    const evidence =
      this.media.playbackEvidence === 'carrier-played' ||
      (this.media.playbackEvidence === 'carrier-processed' &&
        this.session?.acknowledgements.includes('weak-playback-evidence'))
        ? 'confirmed'
        : 'estimated';
    pending.report?.('acknowledged', evidence);
    pending.resolve({ state: 'completed', evidence });
  }

  private cancelMark(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    pending.cancel();
    this.pending.delete(name);
    pending.resolve({ state: 'interrupted', evidence: 'estimated' });
  }

  private cancelAll(): void {
    for (const name of [...this.pending.keys()]) this.cancelMark(name);
  }
}
