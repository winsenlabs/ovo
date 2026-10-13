import type { Clock, NetPort, SpeechToText } from '@winsendotai/ovo-contracts';
import { systemClock } from '@winsendotai/ovo-plugin-kit';
import {
  DEFAULT_BACKLOG_MAX_RATE,
  DEFAULT_CONNECT_TIMEOUT_MS,
  INK2_LANGUAGES,
  WHISPER_LANGUAGES,
  baseLanguage,
  callKeyterms,
  checkManual,
  manualUrl,
  type CartesiaManualBinding,
} from './binding.ts';
import { INK_FORMATS, INK_FRAME_MS, assertInkFormat, connectSession } from './connect.ts';
import { CartesiaSttSession, type SessionOptions, type Start } from './session.ts';
import { FinalizeEvents } from './transcripts.ts';

export const CARTESIA_MANUAL_CAPABILITIES = Object.freeze({
  inputFormats: INK_FORMATS,
  // ink-2's tags. ink-whisper's languages (Tamil, Telugu, …) are offered through
  // `bindingLanguages`, so the host's compat check approves them only for an ink-whisper binding.
  languages: ['en', 'en-IN', 'hi', 'hi-IN', 'fr', 'es', 'ja'],
  bindingLanguages: {
    field: 'model',
    default: 'ink-2',
    by: { 'ink-2': INK2_LANGUAGES, 'ink-whisper': WHISPER_LANGUAGES },
  },
  interim: true,
  wordTimestamps: true,
  // Manual: a final follows only a host `finalize`, so a release must select a local VAD.
  turnSignals: [] as readonly ('end-of-turn' | 'speech-start')[],
  forceEndpoint: true,
  frameMs: INK_FRAME_MS,
});

/**
 * A `/stt/websocket` session (https://docs.cartesia.ai/api-reference/stt/websocket.md, retrieved
 * 2026-10-13). `forceEndpoint` queues the bare text frame `finalize` behind the audio before it;
 * the `is_final` deltas it produces are joined verbatim into one final at its `flush_done`.
 * `finish` finalizes any audio not yet finalized, then sends the bare `close` and ends at `done`.
 */
export class ManualSession extends CartesiaSttSession {
  private readonly finals: FinalizeEvents;
  private unfinalized = false;
  private finalizing = 0;
  private closing = false;

  constructor(
    socket: ConstructorParameters<typeof CartesiaSttSession>[0],
    input: Start,
    options: SessionOptions,
  ) {
    super(socket, input, options);
    this.finals = new FinalizeEvents((event) => input.onEvent(event));
  }

  /** Only when audio arrived since the last one: a finalize with nothing new is not sent. */
  async forceEndpoint(): Promise<void> {
    this.writable();
    if (!this.unfinalized) return;
    this.unfinalized = false;
    this.finalizing += 1;
    this.command('finalize');
  }

  protected wrote(): void {
    this.unfinalized = true;
  }

  protected drainProvider(): void {
    if (this.unfinalized) {
      this.unfinalized = false;
      this.finalizing += 1;
      this.sendNow('finalize');
    }
    this.closeWhenFinalized();
  }

  protected handle(event: Record<string, unknown>): void {
    if (event.type === 'transcript') return this.finals.transcript(event);
    if (event.type === 'flush_done') {
      this.finalizing = Math.max(0, this.finalizing - 1);
      this.finals.settle();
      return this.closeWhenFinalized();
    }
    if (event.type === 'done') {
      this.finals.settle();
      this.end();
    }
  }

  /** A finish that never saw its `flush_done` (or `done`) still delivers the words it held. */
  protected flushPending(): void {
    this.finals.settle();
  }

  private closeWhenFinalized(): void {
    if (this.state !== 'finishing' || this.closing || this.finalizing) return;
    this.closing = true;
    this.sendNow('close');
  }
}

/** Ink with host finalize (`@winsendotai/ovo-stt-cartesia-manual`): ink-2 or ink-whisper. */
export class CartesiaManualStt implements SpeechToText {
  readonly capabilities = CARTESIA_MANUAL_CAPABILITIES;
  readonly binding: Readonly<CartesiaManualBinding>;
  private readonly keyterms: readonly string[];
  private connections = 0;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: CartesiaManualBinding = {},
    private readonly clock: Clock = systemClock,
    agent: { keyterms?: readonly string[] } = {},
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    checkManual(this.binding);
    // Keyterms are an ink-2 feature; an ink-whisper binding ignores the agent's.
    this.keyterms =
      this.binding.model === 'ink-whisper'
        ? []
        : callKeyterms(this.binding.keyterms, agent.keyterms);
  }

  async start(input: Start): Promise<ManualSession> {
    assertInkFormat(input.format);
    const whisper = this.binding.model === 'ink-whisper';
    // ink-whisper transcribes only the binding's pinned language (it does no detection), so a
    // session in another language would be heard as that one: refused. ink-2 detects among its
    // five, so the session language must be one of them.
    if (whisper && baseLanguage(input.language) !== this.binding.language)
      throw new TypeError(
        `Cartesia ink-whisper is pinned to ${this.binding.language}, not ${input.language}`,
      );
    if (!whisper && !INK2_LANGUAGES.includes(baseLanguage(input.language)))
      throw new TypeError(`Cartesia ink-2 does not transcribe ${input.language}`);
    input.signal.throwIfAborted();
    const options: SessionOptions = {
      clock: this.clock,
      provider: 'cartesia-manual',
      attempt: ++this.connections,
      backlogMaxRate: this.binding.backlogMaxRate ?? DEFAULT_BACKLOG_MAX_RATE,
    };
    return connectSession(
      this.net,
      manualUrl(this.binding, input.format, this.keyterms),
      this.key,
      this.clock,
      this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      (socket) => new ManualSession(socket, input, options),
    );
  }
}
