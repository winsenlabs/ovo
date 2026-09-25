import type { Clock } from '@winsendotai/ovo-contracts';

/** Two independent waits: post-speech silence and the STT first/final latency budget. */
export class SpeechStopTimers {
  private cancelSpeech?: () => void;
  private cancelStt?: () => void;
  private speechDone = false;
  private sttDone = false;

  constructor(private readonly clock: Clock, private readonly onSpeechTimeout: () => void, private readonly onReady: () => void) {}

  start(speechMs: number, sttMs: number, finalSeen: boolean): void {
    this.cancel();
    this.sttDone = finalSeen;
    this.cancelSpeech = this.clock.setTimeout(() => {
      this.speechDone = true; this.onSpeechTimeout(); this.maybeReady();
    }, speechMs);
    if (!finalSeen) this.cancelStt = this.clock.setTimeout(() => { this.sttDone = true; this.maybeReady(); }, sttMs);
  }

  final(): void { this.cancelStt?.(); this.cancelStt = undefined; this.sttDone = true; this.maybeReady(); }
  cancel(): void {
    this.cancelSpeech?.(); this.cancelStt?.();
    this.cancelSpeech = this.cancelStt = undefined;
    this.speechDone = this.sttDone = false;
  }
  private maybeReady(): void { if (this.speechDone && this.sttDone) this.onReady(); }
}
