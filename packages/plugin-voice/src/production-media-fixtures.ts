import { expect, vi } from 'vitest';
import type {
  StreamingStt,
  StreamingSttSession,
  StreamingTts,
  TranscriptRevision,
  VoiceMediaTransport,
} from './provider-types.ts';

export class FakeMedia implements VoiceMediaTransport {
  readonly sessionId = 'session-1';
  bufferedBytes = 0;
  autoConfirm = true;
  clears = 0;
  sent: Uint8Array[] = [];
  marks: string[] = [];
  closes: string[] = [];
  private audio = new Set<(audio: Uint8Array, timestampMs: number) => void>();
  private mark = new Set<(name: string) => void>();
  private dtmf = new Set<(digit: string) => void>();
  private closeListeners = new Set<(reason: string) => void>();

  async sendAudio(audio: Uint8Array): Promise<void> {
    this.sent.push(audio.slice());
  }
  async sendMark(name: string): Promise<void> {
    this.marks.push(name);
    if (this.autoConfirm) queueMicrotask(() => this.emitMark(name));
  }
  async clear(): Promise<void> {
    this.clears += 1;
  }
  async close(reason: string): Promise<void> {
    this.closes.push(reason);
    for (const listener of this.closeListeners) listener(reason);
  }
  onAudio(listener: (audio: Uint8Array, timestampMs: number) => void): () => void {
    this.audio.add(listener);
    return () => this.audio.delete(listener);
  }
  onMark(listener: (name: string) => void): () => void {
    this.mark.add(listener);
    return () => this.mark.delete(listener);
  }
  onDtmf(listener: (digit: string) => void): () => void {
    this.dtmf.add(listener);
    return () => this.dtmf.delete(listener);
  }
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  emitAudio(bytes = Uint8Array.of(1)): void {
    for (const listener of this.audio) listener(bytes, 20);
  }
  emitMark(name: string): void {
    for (const listener of this.mark) listener(name);
  }
  emitDtmf(digit: string): void {
    for (const listener of this.dtmf) listener(digit);
  }
}

export const tts: StreamingTts = {
  async *synthesize() {
    yield Uint8Array.of(0x7f, 0x7e);
  },
};

export class FakeStt implements StreamingStt {
  callback?: (revision: TranscriptRevision) => void;
  writes = 0;
  closed = false;
  async start(input: {
    onTranscript: (revision: TranscriptRevision) => void;
  }): Promise<StreamingSttSession> {
    this.callback = input.onTranscript;
    return {
      write: async () => {
        this.writes += 1;
      },
      finish: async () => undefined,
      close: async () => {
        this.closed = true;
      },
    };
  }
}

export async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true));
}
