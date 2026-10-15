import type {
  Clock,
  NetPort,
  SpeechToText,
  SttConfigurationUpdate,
  WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { createLogger, systemClock } from '@winsendotai/ovo-plugin-kit';
import {
  DEFAULT_BACKLOG_MAX_RATE,
  DEFAULT_CONNECT_TIMEOUT_MS,
  ENDPOINTING,
  INK2_LANGUAGES,
  applyUpdate,
  autoUrl,
  baseLanguage,
  callKeyterms,
  checkTurn,
  connectTurn,
  type CartesiaAutoBinding,
  type TurnSettings,
} from './binding.ts';
import { INK_FORMATS, INK_FRAME_MS, assertInkFormat, connectSession } from './connect.ts';
import { CartesiaSttSession, type SessionOptions, type Start } from './session.ts';
import { TurnEvents } from './transcripts.ts';

const logger = createLogger({ service: 'stt-cartesia' });

export const CARTESIA_AUTO_CAPABILITIES = Object.freeze({
  inputFormats: INK_FORMATS,
  // ink-2 detects its five languages itself; these are the tags OVO agents use for them.
  languages: ['en', 'en-IN', 'hi', 'hi-IN', 'fr', 'es', 'ja'],
  interim: true,
  // The turns endpoint documents no word timestamps or confidence.
  wordTimestamps: false,
  turnSignals: ['speech-start', 'end-of-turn', 'eager-end-of-turn', 'turn-resumed'] as const,
  // There is no `finalize` here: the provider ends turns, so no host commit is possible.
  forceEndpoint: false,
  frameMs: INK_FRAME_MS,
});

/**
 * A `/stt/turns/websocket` session: Cartesia detects turns semantically
 * (https://docs.cartesia.ai/api-reference/stt/turns/websocket.md, retrieved 2026-10-13).
 * `updateConfiguration` sends the documented `{"type":"config","turn":{…}}` command; `finish`
 * sends `{"type":"close"}`, after which the provider flushes its buffered audio into events and
 * closes the socket itself.
 */
export class AutoSession extends CartesiaSttSession {
  private readonly turns: TurnEvents;

  constructor(
    socket: WebSocketLike,
    input: Start,
    options: SessionOptions,
    private turn: TurnSettings,
  ) {
    super(socket, input, options);
    this.turns = new TurnEvents((event) => input.onEvent(event));
  }

  async updateConfiguration(update: SttConfigurationUpdate): Promise<void> {
    this.writable();
    // "You cannot add or change keyterms mid-stream" (use-the-api/stt/keyterms.md).
    if (update.keyterms)
      logger.warn('stt_keyterms_fixed_at_connect', { sessionId: this.input.sessionId });
    if (update.endpointing === undefined && update.maxTurnSilenceMs === undefined) return;
    const next = applyUpdate(this.turn, update);
    this.turn = next;
    this.sendNow(
      JSON.stringify({
        type: 'config',
        turn: {
          start_threshold: next.startThreshold,
          eager_end_threshold: next.eagerEndThreshold,
          end_threshold: next.endThreshold,
          end_timeout_ms: next.endTimeoutMs,
        },
      }),
    );
  }

  protected drainProvider(): void {
    this.sendNow(JSON.stringify({ type: 'close' }));
  }

  protected handle(event: Record<string, unknown>): void {
    // `connected` only carries the request id, which the base class has taken.
    this.turns.handle(event);
  }

  protected flushPending(): void {
    this.turns.flush();
  }
}

/** Ink-2 with provider turn detection (`@winsendotai/ovo-stt-cartesia`). */
export class CartesiaAutoStt implements SpeechToText {
  readonly capabilities = CARTESIA_AUTO_CAPABILITIES;
  readonly binding: Readonly<CartesiaAutoBinding>;
  private readonly keyterms: readonly string[];
  private connections = 0;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: CartesiaAutoBinding = {},
    private readonly clock: Clock = systemClock,
    /** The agent's own keyterms (`voice.stt.config.keyterms`), favoured after the binding's. */
    agent: { keyterms?: readonly string[] } = {},
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    const turn = connectTurn(this.binding);
    if (turn) checkTurn(turn);
    this.keyterms = callKeyterms(this.binding.keyterms, agent.keyterms);
  }

  async start(input: Start): Promise<AutoSession> {
    assertInkFormat(input.format);
    if (!INK2_LANGUAGES.includes(baseLanguage(input.language)))
      throw new TypeError(`Cartesia ink-2 does not transcribe ${input.language}`);
    input.signal.throwIfAborted();
    const options: SessionOptions = {
      clock: this.clock,
      provider: 'cartesia',
      attempt: ++this.connections,
      backlogMaxRate: this.binding.backlogMaxRate ?? DEFAULT_BACKLOG_MAX_RATE,
    };
    const turn = connectTurn(this.binding) ?? ENDPOINTING.balanced;
    return connectSession(
      this.net,
      autoUrl(this.binding, input.format, this.keyterms),
      this.key,
      this.clock,
      this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      (socket) => new AutoSession(socket, input, options, turn),
    );
  }
}
