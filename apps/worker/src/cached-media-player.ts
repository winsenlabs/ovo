import type { AudioPlayer, AudioPlaybackRequest } from '@winsendotai/ovo-plugin-speech-cache';
import type { SpeechOutputResult, VoiceMediaTransport } from '@winsendotai/ovo-plugin-voice';

interface PendingMark {
  epoch: number;
  resolve(result: SpeechOutputResult & { usage: [] }): void;
  timer: NodeJS.Timeout;
  report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
}

export class CachedMediaAudioPlayer implements AudioPlayer {
  private readonly pending = new Map<string, PendingMark>();
  private readonly unsubscribeMark: () => void;
  private readonly unsubscribeClose: () => void;

  constructor(
    private readonly media: VoiceMediaTransport,
    private readonly options: { frameBytes?: number; markTimeoutMs?: number } = {},
  ) {
    this.unsubscribeMark = media.onMark((name) => this.confirm(name));
    this.unsubscribeClose = media.onClose(() => this.interruptAll());
  }

  async play(
    request: AudioPlaybackRequest,
    options: {
      signal: AbortSignal;
      report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
    },
  ): Promise<SpeechOutputResult & { usage: [] }> {
    if (request.codec !== 'audio/x-mulaw' || request.sampleRate !== 8_000)
      throw new TypeError('Live cached playback requires 8 kHz mu-law audio');
    if (options.signal.aborted) return interrupted();
    const mark = `${request.segment.id}:${request.segment.epoch}:cache`;
    const onAbort = () => this.cancel(mark);
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      let sent = false;
      const frameBytes = this.options.frameBytes ?? 160;
      for (let offset = 0; offset < request.audio.byteLength; offset += frameBytes) {
        options.signal.throwIfAborted();
        await this.media.sendAudio(
          request.audio.slice(offset, offset + frameBytes),
          options.signal,
        );
        if (!sent) {
          sent = true;
          options.report?.('sent', 'estimated');
        }
      }
      options.signal.throwIfAborted();
      const completion = this.waitForMark(mark, request.segment.epoch, options.report);
      await this.media.sendMark(mark, options.signal);
      return await completion;
    } catch (error) {
      this.cancel(mark);
      if (options.signal.aborted) return interrupted();
      throw error;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  async interrupt(epoch: number): Promise<void> {
    for (const [name, pending] of this.pending) if (pending.epoch === epoch) this.cancel(name);
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
    report?: PendingMark['report'],
  ): Promise<SpeechOutputResult & { usage: [] }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(name);
        resolve(interrupted());
      }, this.options.markTimeoutMs ?? 15_000);
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
    pending.resolve({ state: 'completed', evidence: 'confirmed', usage: [] });
  }

  private cancel(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(name);
    pending.resolve(interrupted());
  }

  private interruptAll(): void {
    for (const name of [...this.pending.keys()]) this.cancel(name);
  }
}

function interrupted(): SpeechOutputResult & { usage: [] } {
  return { state: 'interrupted', evidence: 'estimated', usage: [] };
}
