import { FrameAggregator, msForBytes } from '@winsendotai/ovo-audio';
import { openProviderSocket, usageOnce, type UsageOnce } from '@winsendotai/ovo-plugin-kit';
import {
  MULAW_8K,
  PCM16_16K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type FixtureTemplate,
  type NetFixtureStep,
  type NetPort,
  type SpeechCapabilities,
  type SpeechToText,
  type SttSession,
  type UsageMeter,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';

export const FIXTURE_HOST = 'fixture.invalid';
export const FIXTURE_DOCS = 'https://fixture.invalid/docs';
export const FIXTURE_RETRIEVED = '2026-09-22';
const STT_URL = `wss://${FIXTURE_HOST}/v1/stt`;

export const FIXTURE_STT_CAPABILITIES: SpeechCapabilities = Object.freeze({
  inputFormats: Object.freeze([MULAW_8K, PCM16_16K]),
  frameMs: Object.freeze({ min: 20, max: 1000, preferred: 100 }),
  languages: Object.freeze(['*']),
  interim: true,
  wordTimestamps: false,
  turnSignals: Object.freeze(['speech-start', 'end-of-turn'] as const),
  forceEndpoint: false,
});

/**
 * The fixture STT: a real NetPort client for a made-up JSON protocol on wss://fixture.invalid.
 * It re-frames writes to `frameMs.preferred`, emits usage exactly once and never touches sockets.
 */
export class FixtureSpeechToText implements SpeechToText {
  readonly capabilities = FIXTURE_STT_CAPABILITIES;

  constructor(
    private readonly net: NetPort,
    private readonly options: { clock?: Clock; token?: string } = {},
  ) {}

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<SttSession> {
    const format = this.capabilities.inputFormats!.find((f) => sameFormat(f, input.format));
    if (!format) throw new TypeError('fixture STT: non-native input format');
    const url = `${STT_URL}?language=${encodeURIComponent(input.language)}&encoding=${format.encoding}&sample_rate=${format.sampleRate}`;
    const startedAt = this.options.clock?.now() ?? Date.now();
    const socket = await openProviderSocket(
      this.net,
      url,
      { authorization: `Token ${this.options.token ?? 'fixture'}` },
      [FIXTURE_HOST],
      { signal: input.signal, clock: this.options.clock },
    );
    return new FixtureSttSession(socket, input, format, startedAt, this.options.clock);
  }
}

class FixtureSttSession implements SttSession {
  private state: 'open' | 'finishing' | 'closed' = 'open';
  private readonly frames: FrameAggregator;
  private readonly usage: UsageOnce;
  private bytes = 0;
  private segment = 0;
  private revision = 0;
  private readonly closed: Promise<void>;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Parameters<SpeechToText['start']>[0],
    private readonly format: AudioFormat,
    private readonly startedAt: number,
    private readonly clock?: Clock,
  ) {
    this.frames = new FrameAggregator(format, FIXTURE_STT_CAPABILITIES.frameMs!.preferred);
    this.usage = usageOnce(input.onUsage);
    socket.on('message', (data) => this.onMessage(data));
    this.closed = new Promise((resolve) =>
      socket.on('close', () => {
        this.state = 'closed';
        this.estimate();
        resolve();
      }),
    );
    input.signal.addEventListener('abort', () => void this.cancel('aborted'), { once: true });
  }

  private meter(quantity: number, state: UsageMeter['state'], requestId: string): UsageMeter {
    return {
      provider: 'fixture',
      operation: 'stt',
      unit: 'audio_seconds',
      quantity: quantity.toFixed(3),
      state,
      requestId,
      elapsedMs: (this.clock?.now() ?? Date.now()) - this.startedAt,
    };
  }

  private estimate(): void {
    const seconds = msForBytes(this.format, this.bytes) / 1000;
    this.usage.emit(this.meter(seconds, 'estimated', `fixture:${this.input.sessionId}:1`));
  }

  private onMessage(data: string | Uint8Array): void {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data) as Record<string, unknown>;
    const emit = this.input.onEvent;
    if (message.type === 'speech_started') emit({ type: 'speech-start' });
    else if (message.type === 'end_of_turn') emit({ type: 'end-of-turn' });
    else if (message.type === 'transcript') {
      const final = message.final === true;
      emit({
        type: 'transcript',
        segment: {
          segmentId: `${this.input.sessionId}:${this.segment}`,
          revision: ++this.revision,
          text: String(message.text ?? ''),
          stability: final ? 'final' : 'interim',
        },
      });
      if (final) this.segment += 1;
    } else if (message.type === 'usage')
      this.usage.emit(
        this.meter(Number(message.seconds), 'reconciled', String(message.request_id)),
      );
  }

  async write(frame: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw new Error('fixture STT session is closed');
    this.bytes += frame.byteLength;
    for (const full of this.frames.push(frame)) this.socket.send(full);
  }

  async finish(): Promise<void> {
    if (this.state !== 'open') return this.closed;
    this.state = 'finishing';
    const rest = this.frames.flush({ padToMs: FIXTURE_STT_CAPABILITIES.frameMs!.min });
    if (rest) this.socket.send(rest);
    this.socket.send(JSON.stringify({ type: 'finish' }));
    await this.closed;
  }

  async cancel(_reason?: string): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.estimate();
    this.socket.close(1000, 'cancelled');
  }
}

/** Renders every `say` as speech_started, word-by-word interims, a final and end_of_turn. */
export const fixtureSttTemplate: FixtureTemplate = (input) => {
  const steps: NetFixtureStep[] = [
    {
      expect: 'ws-open',
      url: /^wss:\/\/fixture\.invalid\/v1\/stt\?/,
      headers: { authorization: 'Token fixture' },
    },
    { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
  ];
  for (const turn of input.turns) {
    if (!turn.say) continue;
    steps.push({ send: JSON.stringify({ type: 'speech_started' }) });
    const words = turn.say.split(/\s+/).filter(Boolean);
    for (let i = 1; i < words.length; i += 1)
      steps.push({
        send: JSON.stringify({
          type: 'transcript',
          text: words.slice(0, i).join(' '),
          final: false,
        }),
      });
    steps.push({ send: JSON.stringify({ type: 'transcript', text: turn.say, final: true }) });
    steps.push({ send: JSON.stringify({ type: 'end_of_turn' }) });
  }
  const seconds = input.turns.reduce((sum, turn) => sum + (turn.silenceMs ?? 0), 0) / 1000 || 1;
  steps.push(
    { expect: 'ws-send', match: 'json', where: { type: 'finish' } },
    {
      send: JSON.stringify({
        type: 'usage',
        seconds,
        request_id: `fixture-stt-${input.sessionId}`,
      }),
    },
    { close: { code: 1000, reason: 'done' } },
  );
  return [
    { host: FIXTURE_HOST, source: `${FIXTURE_DOCS}/stt`, retrieved: FIXTURE_RETRIEVED, steps },
  ];
};
