import { bytesPerSecond, type TtsReply } from '@winsendotai/ovo-contracts';
import { decimal } from '@winsendotai/ovo-plugin-kit';
import type { Alignment, ContextSink, MultiContextConnection } from './connection.ts';
import { ElevenLabsTtsError, SampleAligner } from './errors.ts';
import { partAudio, spokenCount, unspokenText, type Part, type ReplyInit } from './reply-part.ts';

/**
 * LAT-5: every segment of one agent reply on one `multi-stream-input` context. The context is
 * initialised with a single space (the documented shape), then each segment goes out as whole words
 * ending in a space with `flush: true`, so the provider renders it at once whatever `auto_mode` or
 * `chunk_length_schedule` say. Audio is cut back into segments by the frames' character alignment:
 * a segment ends where the next one's first spoken character starts (or on isFinal, or a quiet gap),
 * never at its own last letter, whose phoneme, punctuation and silence can still follow.
 * A socket that drops replays the unheard rest over HTTP instead of failing the reply.
 *
 * Each segment is metered when it is done, under `<requestId>/<n>`: a reply's last sentence is
 * often the goodbye, and a meter held until the context closes could outlive the session.
 */
export class ElevenLabsReply implements TtsReply, ContextSink {
  private readonly parts: Part[] = [];
  /** Segments flushed on the socket, in order, and how many of them an isFinal has ended. */
  private readonly flushed: Part[] = [];
  private finals = 0;
  private readonly aligner: SampleAligner;
  private readonly bytesPerMs: number;
  private readonly width: number;
  private readonly detachAbort: () => void;
  private socket?: { connection: MultiContextConnection; release: () => void };
  private httpTail: Promise<void> = Promise.resolve();
  private cancelQuiet?: () => void;
  /** Audio after every segment had ended (the quiet net ended it early); it leads the next one. */
  private carry: Uint8Array[] = [];
  /** A socket failure that is not replayed: every later segment fails with it. */
  private failure?: Error;
  private alignmentSeen = false;
  private characters = 0;
  private closed = false;

  constructor(private readonly init: ReplyInit) {
    this.aligner = new SampleAligner(init.input.format);
    this.bytesPerMs = bytesPerSecond(init.input.format) / 1000;
    this.width = init.input.format.encoding === 'pcm_s16le' ? 2 : 1;
    const abort = () => void this.close();
    init.input.signal.addEventListener('abort', abort, { once: true });
    this.detachAbort = () => init.input.signal.removeEventListener('abort', abort);
    if (!init.socket) return;
    this.socket = init.socket;
    init.socket.connection.register(init.contextId, this);
    try {
      init.socket.connection.send({ text: ' ', context_id: init.contextId, ...init.opening });
    } catch (error) {
      this.onError(error as Error);
    }
  }

  segment(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.closed) throw new ElevenLabsTtsError('ElevenLabs TTS reply is closed', false);
    const words = text.trim();
    const size = [...words].length + 1;
    if (this.characters + size > this.init.limit)
      throw new TypeError(`ElevenLabs TTS text must contain 1–${this.init.limit} characters`);
    const part: Part = {
      text: words,
      spoken: spokenCount(words),
      aligned: 0,
      received: 0,
      queue: [],
      done: false,
      dropped: false,
      socketChars: 0,
      sentAt: this.init.clock.now(),
      controller: new AbortController(),
    };
    // Punctuation alone renders nothing, so it never goes out and its iterable just ends.
    if (!part.spoken) return partAudio(part, signal);
    this.characters += size;
    this.parts.push(part);
    for (const bytes of this.carry.splice(0)) this.give(part, bytes);
    if (this.failure) this.fail(part, this.failure);
    else if (this.socket) {
      try {
        // Whole words ending in a single space, as the reference asks of every text frame.
        this.socket.connection.send({
          text: `${words} `,
          context_id: this.init.contextId,
          flush: true,
        });
        part.socketChars = size;
        this.flushed.push(part);
        this.armQuiet();
      } catch (error) {
        this.onError(error as Error);
      }
    } else this.overHttp(part, words);
    return partAudio(part, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelQuiet?.();
    this.detachAbort();
    if (this.socket) {
      const { connection } = this.socket;
      if (connection.usable)
        try {
          connection.send({ context_id: this.init.contextId, close_context: true });
        } catch {
          // swallow-ok: a socket that cannot take the frame has already failed every context.
        }
      this.releaseSocket();
    }
    this.carry = [];
    for (const part of this.parts) {
      part.controller.abort(new DOMException('ElevenLabs TTS reply closed', 'AbortError'));
      this.finish(part);
    }
  }

  onAudio(bytes: Uint8Array, alignment?: Alignment): void {
    if (this.closed) return;
    const whole = this.aligner.push(bytes);
    if (!whole) return;
    let offset = 0;
    if (alignment) {
      alignment.chars.forEach((char, index) => {
        const spoken = spokenCount(char);
        if (!spoken) return;
        let head = this.head();
        // The next segment's first spoken character ends this one: cut the frame where it starts.
        const rest =
          head && head.aligned >= head.spoken ? this.parts.slice(this.parts.indexOf(head) + 1) : [];
        const next = rest.find((part) => !part.done);
        if (head && next) {
          const cut = this.cutAt(alignment.charStartTimesMs[index]!, offset, whole.byteLength);
          this.give(head, whole.subarray(offset, cut));
          offset = cut;
          this.finish(head);
          head = next;
        }
        // Past the last segment's own count, our count and the provider's disagree: it stays there.
        if (head) head.aligned += spoken;
      });
      this.alignmentSeen = true;
    }
    // The rest belongs to the segment playing now, even with no new spoken character in it.
    const head = this.head();
    if (head) this.give(head, whole.subarray(offset));
    else if (offset < whole.byteLength) this.carry.push(whole.slice(offset));
    this.armQuiet();
  }

  /**
   * An isFinal before close_context. Whether the provider sends one per flush is UNCONFIRMED (a
   * compatible provider documents "every audio frame for text sent before your flush has been
   * delivered"); if it does, the n-th one ends the n-th flushed segment exactly, and anything
   * still open before it. Contexts here never idle long enough to time out on the server.
   */
  onFinal(): void {
    if (this.closed) return;
    const last = this.flushed[this.finals++];
    if (!last) return;
    for (const part of this.flushed.slice(0, this.finals)) this.finish(part);
    this.armQuiet();
  }

  onError(error: Error): void {
    if (this.closed || !this.socket) return;
    this.cancelQuiet?.();
    this.releaseSocket();
    const pending = this.parts.filter((part) => !part.done);
    if (!this.init.replay || !(error instanceof ElevenLabsTtsError) || !error.retryable) {
      this.failure = error;
      for (const part of pending) this.fail(part, error);
      return;
    }
    for (const part of pending) {
      if (part.dropped) {
        this.finish(part);
        continue;
      }
      // Nothing was heard: the HTTP request is billed instead of the socket's estimate.
      if (!part.received) part.socketChars = 0;
      const rest = part.received ? unspokenText(part.text, part.aligned) : part.text;
      if (rest) this.overHttp(part, rest);
      else this.finish(part);
    }
  }

  private head(): Part | undefined {
    return this.parts.find((part) => !part.done);
  }

  private cutAt(ms: number, from: number, length: number): number {
    const at = Math.round((ms * this.bytesPerMs) / this.width) * this.width;
    return Math.min(length, Math.max(from, at));
  }

  private give(part: Part, bytes: Uint8Array): void {
    if (!bytes.byteLength) return;
    part.received += bytes.byteLength;
    if (part.dropped) return;
    part.queue.push(bytes);
    part.wake?.();
  }

  private finish(part: Part): void {
    if (part.done) return;
    part.done = true;
    part.wake?.();
    if (!part.socketChars) return;
    this.init.input.onUsage({
      provider: 'elevenlabs',
      operation: 'tts',
      unit: 'characters',
      quantity: decimal(part.socketChars),
      // The socket reports no billed count, so the sent characters stay an estimate.
      state: 'estimated',
      requestId: `${this.init.requestId}/${this.parts.indexOf(part) + 1}`,
      elapsedMs: Math.max(0, this.init.clock.now() - part.sentAt),
    });
  }

  private fail(part: Part, error: Error): void {
    part.error = error;
    this.finish(part);
  }

  /**
   * `quietMs` without audio ends a head whose every character is aligned (how a reply's last
   * segment ends without an isFinal); before that, our count and the provider's disagree, so it
   * waits four times as long. Without alignment the head already holds every flushed segment's
   * audio, so all of them end. A segment still waiting for its first audio never ends this way.
   */
  private armQuiet(): void {
    this.cancelQuiet?.();
    this.cancelQuiet = undefined;
    const head = this.head();
    const pending = this.parts.filter((part) => !part.done);
    if (!this.socket || !head || !pending.some((part) => part.received)) return;
    const heard = !this.alignmentSeen || head.aligned >= head.spoken;
    this.cancelQuiet = this.init.clock.setTimeout(
      () => {
        this.cancelQuiet = undefined;
        if (this.closed || !this.socket) return;
        const waiting = this.parts.filter((part) => !part.done);
        for (const part of this.alignmentSeen ? waiting.slice(0, 1) : waiting) this.finish(part);
        this.armQuiet();
      },
      heard ? this.init.quietMs : this.init.quietMs * 4,
    );
  }

  /** HTTP segments render one after another, in order, each into its own part. */
  private overHttp(part: Part, text: string): void {
    this.httpTail = this.httpTail.then(async () => {
      if (part.dropped || part.done) return this.finish(part);
      try {
        for await (const chunk of this.init.render(
          text,
          part.controller.signal,
          this.init.input.onUsage,
        ))
          this.give(part, chunk);
        this.finish(part);
      } catch (error) {
        if (part.dropped || this.closed) this.finish(part);
        else this.fail(part, error as Error);
      }
    });
  }

  private releaseSocket(): void {
    if (!this.socket) return;
    this.socket.connection.unregister(this.init.contextId);
    this.socket.release();
    this.socket = undefined;
  }
}
