import { stt, asLanguageCode, DEFAULT_API_CONNECT_OPTIONS } from '@livekit/agents';
import type { SttEvent } from '@winsendotai/ovo-contracts';
import type { SttGate } from './stt-gate.ts';
import { encode } from './codec.ts';
import type { LiveKitPorts } from './types.ts';

class OvoSpeechStream extends stt.SpeechStream {
  label = 'ovo-stt-stream';
  constructor(
    owner: stt.STT,
    private readonly ports: LiveKitPorts,
    private readonly shutdown: AbortSignal,
    private readonly gate: SttGate,
  ) {
    super(owner, 8000, { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 });
  }
  protected async run(): Promise<void> {
    if (!this.ports.stt) throw new Error('Input-enabled LiveKit requires ovo.stt');
    let last = '';
    const finalized = new Set<string>();
    const event = (e: SttEvent) => {
      if (this.abortSignal.aborted || this.shutdown.aborted) return;
      if (e.type === 'transcript') {
        if (finalized.has(e.segment.segmentId)) return;
        if (e.segment.stability === 'final') finalized.add(e.segment.segmentId);
        last = e.segment.text;
      }
      const type =
        e.type === 'speech-start'
          ? stt.SpeechEventType.START_OF_SPEECH
          : e.type === 'transcript'
            ? e.segment.stability === 'final'
              ? stt.SpeechEventType.FINAL_TRANSCRIPT
              : stt.SpeechEventType.INTERIM_TRANSCRIPT
            : e.type === 'end-of-turn' || e.type === 'utterance-end'
              ? stt.SpeechEventType.END_OF_SPEECH
              : undefined;
      if (type !== undefined)
        this.queue.put({
          type,
          alternatives: [
            {
              language: asLanguageCode(this.ports.session.language),
              text: last,
              startTime: 0,
              endTime: 0,
              confidence: 1,
            },
          ],
        });
    };
    const provider = await this.ports.stt.start({
      sessionId: this.ports.media.sessionId,
      format: this.ports.media.format,
      language: this.ports.session.language,
      signal: AbortSignal.any([this.abortSignal, this.shutdown]),
      onUsage: this.ports.usage,
      onEvent: (e) => this.gate.accept(e, event),
    });
    try {
      for await (const frame of this.input) {
        if (typeof frame === 'symbol') continue;
        await provider.write(encode(frame, this.ports.media.format));
      }
    } finally {
      await provider.cancel('livekit-stream-closed');
    }
  }
}
export class OvoStt extends stt.STT {
  label = 'ovo-stt';
  private readonly shutdown = new AbortController();
  stop(): void {
    this.shutdown.abort();
  }
  constructor(
    private readonly ports: LiveKitPorts,
    private readonly gate: SttGate,
  ) {
    super({ streaming: true, interimResults: true });
  }
  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('OVO STT is streaming only');
  }
  stream(): stt.SpeechStream {
    return new OvoSpeechStream(this, this.ports, this.shutdown.signal, this.gate);
  }
}
