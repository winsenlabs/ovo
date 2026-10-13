import type { TtsReply } from '@winsendotai/ovo-contracts';
import type { CartesiaSocket, ContextSink } from './connection.ts';
import { CartesiaTtsError, WholeSamples, asCartesiaError } from './errors.ts';
import {
  CONTEXT_QUIET_MS,
  finishPart,
  newPart,
  speaks,
  type Context,
  type Part,
  type ReplyInit,
} from './reply-part.ts';
import { RETRY_PAUSES_MS, pause, whenAborted, withinLimit } from './slots.ts';

export { CONTEXT_QUIET_MS, type ReplyInit } from './reply-part.ts';

/**
 * LAT-5: the segments of one agent reply on one Sonic context. Each segment goes out as
 * `{transcript: "<words> ", continue: true}` then `{transcript: "", continue: true, flush: true}`;
 * its audio is every chunk until the matching `flush_done`, which the in-order guarantee makes
 * exact ("Outputs for a given context will always be in order of the inputs"). Whether chunks
 * also carry `flush_id` is UNCONFIRMED, so they are routed by order, not by id.
 * Each segment is metered when it ends, under `<requestId>/<n>`.
 */
export class CartesiaReply implements TtsReply {
  private readonly parts: Part[] = [];
  private readonly stopAbort: () => void;
  private context?: Context;
  private contexts = 0;
  private connecting = false;
  private pausing = false;
  private retries = 0;
  private characters = 0;
  private failure?: Error;
  private closed = false;

  constructor(private readonly init: ReplyInit) {
    this.stopAbort = whenAborted(init.input.signal, () => void this.close());
    this.context = this.open(init.socket);
  }

  segment(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.closed) throw new CartesiaTtsError('Cartesia TTS reply is closed', false);
    const words = text.trim();
    const part = newPart(this.parts.length + 1, words, this.init.clock.now());
    if (!speaks(words)) {
      part.done = true;
      part.queue.end();
      return part.queue.read(signal);
    }
    const before = this.characters;
    this.characters = withinLimit(before, part.text, this.init.limit);
    part.chars = this.characters - before;
    this.parts.push(part);
    if (this.failure) this.finish(part, this.failure);
    else this.pump();
    const drop = () => {
      part.queue.discard();
      part.queue.end();
    };
    if (signal.aborted) drop();
    else signal.addEventListener('abort', drop, { once: true });
    return part.queue.read(signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopAbort();
    const context = this.context;
    this.context = undefined;
    if (context) {
      if (this.parts.some((part) => part.context === context && !part.done))
        try {
          context.socket.send({ context_id: context.id, cancel: true });
        } catch {
          // swallow-ok: a socket that cannot take the frame has failed, and its contexts with it.
        }
      context.socket.detach(context.id, context.sink);
    }
    // Barge-in: what the provider still sends for these segments is never heard.
    for (const part of this.parts)
      if (!part.done) {
        part.queue.discard();
        this.finish(part);
      }
    this.init.release();
  }

  /** Sends every unsent segment in order, on a live context, reconnecting first if needed. */
  private pump(): void {
    if (this.closed || this.failure || this.pausing || this.connecting) return;
    if (!this.context?.socket.usable) return this.reconnect();
    for (const part of this.parts) {
      if (part.sent || part.done) continue;
      if (this.stale(this.context)) this.rotate(this.context.socket);
      if (!this.send(part, this.context!)) return;
    }
  }

  private send(part: Part, context: Context): boolean {
    part.context = context;
    part.flushId = ++context.flushes;
    part.sent = part.everSent = true;
    part.sentAt = this.init.clock.now();
    try {
      context.socket.send({
        ...this.init.fields,
        context_id: context.id,
        transcript: part.text,
        continue: true,
      });
      context.socket.send({
        ...this.init.fields,
        context_id: context.id,
        transcript: '',
        continue: true,
        flush: true,
      });
      return true;
    } catch (error) {
      this.contextFailed(context, asCartesiaError(error));
      return false;
    }
  }

  /** Every segment on it has ended and it has been quiet long enough to have expired. */
  private stale(context: Context): boolean {
    if (!context.flushes) return false;
    if (this.parts.some((part) => part.context === context && !part.done)) return false;
    return this.init.clock.now() - context.quietSince > CONTEXT_QUIET_MS;
  }

  private open(socket: CartesiaSocket): Context {
    this.contexts += 1;
    const id = this.contexts > 1 ? `${this.init.contextId}-${this.contexts}` : this.init.contextId;
    const sink: ContextSink = {
      chunk: (audio) => this.chunk(context, audio),
      flushed: (flushId) => this.flushed(context, flushId),
      done: () => this.endContext(context),
      failed: (error) => this.contextFailed(context, error),
    };
    const context: Context = {
      id,
      socket,
      sink,
      samples: new WholeSamples(this.init.input.format),
      flushes: 0,
      heard: false,
      quietSince: this.init.clock.now(),
    };
    socket.attach(id, context.sink);
    return context;
  }

  /** Lets an expired context go (nothing is sent on it) and opens the next id on `socket`. */
  private rotate(socket: CartesiaSocket): void {
    if (this.context) this.context.socket.detach(this.context.id, this.context.sink);
    this.context = this.open(socket);
  }

  private reconnect(): void {
    if (this.context) this.context.socket.detach(this.context.id, this.context.sink);
    this.context = undefined;
    this.connecting = true;
    this.init
      .connect(this.init.input.signal)
      .then((socket) => {
        this.connecting = false;
        if (this.closed) return;
        this.context = this.open(socket);
        this.pump();
      })
      .catch((error: unknown) => {
        this.connecting = false;
        this.retryOrFail(asCartesiaError(error), false);
      });
  }

  private chunk(context: Context, audio: Uint8Array): void {
    if (this.closed) return;
    context.heard = true;
    context.quietSince = this.init.clock.now();
    const head = this.parts.find((part) => part.context === context && !part.done);
    // A chunk after every flush_done of its context has nowhere to go: dropped.
    if (!head) return;
    head.heard = true;
    head.queue.push(context.samples.take(audio));
  }

  /** `flush_done` n ends the n-th segment flushed on the context, and anything before it. */
  private flushed(context: Context, flushId: number | undefined): void {
    if (this.closed) return;
    context.quietSince = this.init.clock.now();
    const open = this.parts.filter((part) => part.context === context && !part.done);
    const upTo = flushId ?? open[0]?.flushId ?? 0;
    for (const part of open) if (part.flushId <= upTo) this.finish(part);
  }

  /** `done` ends the context on the provider's side: whatever is still open on it is over. */
  private endContext(context: Context): void {
    if (this.closed) return;
    for (const part of this.parts) if (part.context === context && !part.done) this.finish(part);
    if (this.context === context) {
      context.socket.detach(context.id, context.sink);
      this.context = undefined;
    }
  }

  private contextFailed(context: Context, error: CartesiaTtsError | Error): void {
    if (this.closed || context !== this.context) return;
    context.socket.detach(context.id, context.sink);
    this.context = undefined;
    // Segments sent on it that never ended go out again on the next context, unheard ones only.
    for (const part of this.parts) if (part.context === context && !part.done) part.sent = false;
    this.retryOrFail(error, context.heard);
  }

  private retryOrFail(error: CartesiaTtsError | Error, heard: boolean): void {
    const retry =
      !heard &&
      !this.closed &&
      error instanceof CartesiaTtsError &&
      error.retryable &&
      this.retries < RETRY_PAUSES_MS.length;
    if (!retry) return this.fail(error);
    this.retries += 1;
    this.pausing = true;
    pause(this.init.clock, RETRY_PAUSES_MS[this.retries - 1]!, this.init.input.signal)
      .then(() => {
        this.pausing = false;
        this.pump();
      })
      .catch((caught: unknown) => {
        this.pausing = false;
        this.fail(asCartesiaError(caught));
      });
  }

  private fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const part of this.parts) if (!part.done) this.finish(part, error);
  }

  private finish(part: Part, error?: Error): void {
    finishPart(this.init, part, error);
  }
}
