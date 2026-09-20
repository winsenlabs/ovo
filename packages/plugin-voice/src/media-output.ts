import type { SpeechOutput, SpeechOutputResult, SpeechSegment } from './types.ts';
import type { StreamingTts, VoiceMediaTransport } from './provider-types.ts';

interface PendingMark {
  epoch: number;
  resolve: (result: SpeechOutputResult) => void;
  timer: NodeJS.Timeout;
  report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
}

export interface StreamingMediaOutputConfig {
  markTimeoutMs?: number;
  voice?: string;
}

export class StreamingMediaSpeechOutput implements SpeechOutput {
  private readonly pending = new Map<string, PendingMark>();
  private readonly unsubscribeMark: () => void;
  private readonly unsubscribeClose: () => void;
  private readonly markTimeoutMs: number;

  constructor(
    private readonly tts: StreamingTts,
    private readonly media: VoiceMediaTransport,
    private readonly config: StreamingMediaOutputConfig = {},
  ) {
    this.markTimeoutMs = config.markTimeoutMs ?? 15_000;
    this.unsubscribeMark = media.onMark((name) => this.confirm(name));
    this.unsubscribeClose = media.onClose(() => this.interruptAll());
  }

  async play(
    segment: SpeechSegment,
    options: {
      signal: AbortSignal;
      report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
    },
  ): Promise<SpeechOutputResult> {
    if (options.signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
    const mark = `${segment.id}:${segment.epoch}`;
    const interrupted = () => this.cancelMark(mark);
    options.signal.addEventListener('abort', interrupted, { once: true });
    try {
      let sent = false;
      for await (const chunk of this.tts.synthesize({
        sessionId: this.media.sessionId,
        text: segment.text,
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        voice: this.config.voice,
        signal: options.signal,
      })) {
        options.signal.throwIfAborted();
        if (chunk.length === 0) continue;
        await this.media.sendAudio(chunk, options.signal);
        if (!sent) {
          sent = true;
          options.report?.('sent', 'estimated');
        }
      }
      options.signal.throwIfAborted();
      const completion = this.waitForMark(mark, segment.epoch, options.report);
      await this.media.sendMark(mark, options.signal);
      return await completion;
    } catch (error) {
      this.cancelMark(mark);
      if (options.signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      throw error;
    } finally {
      options.signal.removeEventListener('abort', interrupted);
    }
  }

  async interrupt(epoch: number): Promise<void> {
    for (const [name, pending] of this.pending) if (pending.epoch === epoch) this.cancelMark(name);
    await this.media.clear();
  }

  dispose(): void {
    this.interruptAll();
    this.unsubscribeMark();
    this.unsubscribeClose();
  }

  private waitForMark(
    name: string,
    epoch: number,
    report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void,
  ): Promise<SpeechOutputResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(name);
        resolve({ state: 'interrupted', evidence: 'estimated' });
      }, this.markTimeoutMs);
      timer.unref?.();
      this.pending.set(name, { epoch, resolve, timer, report });
    });
  }

  private confirm(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(name);
    pending.report?.('acknowledged', 'confirmed');
    pending.resolve({ state: 'completed', evidence: 'confirmed' });
  }

  private cancelMark(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(name);
    pending.resolve({ state: 'interrupted', evidence: 'estimated' });
  }

  private interruptAll(): void {
    for (const name of [...this.pending.keys()]) this.cancelMark(name);
  }
}
