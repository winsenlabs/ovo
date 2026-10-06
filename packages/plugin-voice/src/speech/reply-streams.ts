import type {
  AudioFormat,
  Clock,
  SpeechSegment,
  SynthesisInput,
  TextToSpeech,
  TtsReply,
} from '@winsendotai/ovo-contracts';

type SegmentInput = Omit<SynthesisInput, 'text'>;
type SegmentAudio = (segment: SpeechSegment, input: SegmentInput) => AsyncIterable<Uint8Array>;

interface OpenReply {
  epoch: number;
  /** Undefined when the provider could not open one: the epoch's segments go one by one. */
  reply: Promise<TtsReply | undefined>;
  controller: AbortController;
  pending: number;
  cancelIdle?: () => void;
  /** Superseded by a newer epoch: closes once its last segment has played out. */
  retired?: boolean;
}

/** A reply that has rendered every segment so far is closed after this long without a new one. */
export const REPLY_IDLE_MS = 1_500;

const realTimers: Pick<Clock, 'setTimeout'> = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * LAT-5 `speakStream`. The turn driver begins a response epoch per agent reply and speaks it
 * segment by segment, each already through the guardrail and the text filters; here every segment
 * of one epoch goes into one provider context (`TextToSpeech.openReply`), in the order the
 * scheduler prepares them. Each segment still has its own audio, carrier mark and receipt, so
 * PlaybackConversation and barge-in see sentences exactly as before. A barge-in or an idle reply
 * closes the context, and a new epoch once the old one's segments have played; only that context,
 * never the session's socket.
 *
 * Segments are pushed whole, never token by token: a guardrail-blocked sentence must not reach the
 * provider, the text filters need whole phrases, and ElevenLabs' `auto_mode` is "recommended for
 * full sentences/phrases". The early first segment (LAT-9) is what starts audio sooner.
 */
export class ReplyStreams {
  private current?: OpenReply;

  private constructor(
    private readonly tts: TextToSpeech & Required<Pick<TextToSpeech, 'openReply'>>,
    /** The per-segment path, for a provider that could not open a reply. */
    private readonly fallback: SegmentAudio,
    private readonly clock: Pick<Clock, 'setTimeout'>,
    private readonly idleMs: number,
  ) {}

  /** Reply streaming for `tts`, or undefined when it has no `openReply`. */
  static for(
    tts: TextToSpeech,
    fallback: SegmentAudio,
    options: { clock?: Pick<Clock, 'setTimeout'>; idleMs?: number } = {},
  ): ReplyStreams | undefined {
    if (!tts.openReply) return undefined;
    return new ReplyStreams(
      tts as TextToSpeech & Required<Pick<TextToSpeech, 'openReply'>>,
      fallback,
      options.clock ?? realTimers,
      options.idleMs ?? REPLY_IDLE_MS,
    );
  }

  /** One segment's audio, rendered in its epoch's reply context. */
  audio(segment: SpeechSegment, input: SegmentInput): AsyncIterable<Uint8Array> {
    const open = this.openFor(segment.epoch, input);
    open.pending += 1;
    open.cancelIdle?.();
    open.cancelIdle = undefined;
    // Pushed now, while the scheduler prepares segments in order, not when playback reaches it.
    const audio = open.reply.then((reply) => reply?.segment(segment.text, input.signal));
    void audio.catch(() => undefined);
    return this.stream(open, audio, segment, input);
  }

  /** Barge-in: closes that epoch's context, if it is the open one. */
  close(epoch: number): void {
    if (this.current?.epoch === epoch) this.closeReply(this.current);
  }

  dispose(): void {
    if (this.current) this.closeReply(this.current);
  }

  private closeReply(open: OpenReply): void {
    if (this.current !== open) return;
    this.current = undefined;
    this.shut(open);
  }

  /**
   * A new epoch without a barge-in. Closing the old context now would cut the audio its last
   * segment still has coming (the provider ends a segment after its tail, not at its last letter).
   */
  private retire(open: OpenReply): void {
    this.current = undefined;
    open.cancelIdle?.();
    if (open.pending) open.retired = true;
    else this.shut(open);
  }

  private shut(open: OpenReply): void {
    open.cancelIdle?.();
    open.controller.abort(new DOMException('reply closed', 'AbortError'));
    // swallow-ok: a reply that failed to open has nothing to close.
    void open.reply.then((reply) => reply?.close()).catch(() => undefined);
  }

  private openFor(epoch: number, input: SegmentInput): OpenReply {
    if (this.current?.epoch === epoch) return this.current;
    if (this.current) this.retire(this.current);
    const controller = new AbortController();
    const reply = this.tts
      .openReply({ ...input, signal: controller.signal })
      .catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        return undefined;
      });
    this.current = { epoch, reply, controller, pending: 0 };
    return this.current;
  }

  private async *stream(
    open: OpenReply,
    audio: Promise<AsyncIterable<Uint8Array> | undefined>,
    segment: SpeechSegment,
    input: SegmentInput,
  ): AsyncIterable<Uint8Array> {
    try {
      let source: AsyncIterable<Uint8Array> | undefined;
      try {
        source = await audio;
      } catch (error) {
        // The reply refused the segment (closed under it, or over its budget): speak it alone.
        input.signal.throwIfAborted();
        if (open.controller.signal.aborted) throw error;
        this.closeReply(open);
      }
      if (!source) {
        yield* this.fallback(segment, input);
        return;
      }
      try {
        yield* source;
      } catch (error) {
        // A failed reply is not reused: the epoch's next segment opens a fresh one.
        if (!input.signal.aborted) this.closeReply(open);
        throw error;
      }
    } finally {
      open.pending -= 1;
      if (!open.pending && open.retired) this.shut(open);
      else if (!open.pending && this.current === open)
        open.cancelIdle = this.clock.setTimeout(() => {
          if (!open.pending) this.closeReply(open);
        }, this.idleMs);
    }
  }
}

/** Opens the session's TTS connection at session start (Wave 2 request #2); never throws. */
export function warmSessionTts(tts: TextToSpeech, format: AudioFormat, voice?: string): void {
  try {
    // swallow-ok: warming is an optimisation; the first utterance connects (or falls back) itself.
    void tts.warm?.({ format, ...(voice ? { voice } : {}) }).catch(() => undefined);
  } catch {
    // swallow-ok: as above, for a warm that throws before returning its promise.
  }
}
