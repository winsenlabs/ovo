import { bytesPerSecond, type Clock, type SpeechToText } from '@winsendotai/ovo-contracts';
import { createLogger, decimal, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';

const logger = createLogger({ service: 'stt-assemblyai' });

/**
 * How long a cancelled or aborted session waits for Termination, whose `session_duration_seconds`
 * is what the provider bills (OPS-18). It arrives in about a round trip; past this the wall-clock
 * estimate is metered so a hang-up is never held up for long.
 */
export const TERMINATION_GRACE_MS = 750;

/** One session's usage: emitted exactly once, reconciled when a Termination reported a duration. */
export class AssemblyAiUsage {
  private readonly once;
  private readonly startedAt: number;
  private audioBytes = 0;
  /** Begin's session id, the requestId once known. */
  providerId?: string;
  /** Termination's billed session length. */
  duration?: number;

  constructor(
    private readonly input: Parameters<SpeechToText['start']>[0],
    private readonly clock: Clock,
    /** Distinguishes the estimated usage of each connect attempt or reconnect in one call. */
    private readonly attempt: number,
  ) {
    this.startedAt = clock.now();
    this.once = usageOnce(input.onUsage);
  }

  sent(bytes: number): void {
    this.audioBytes += bytes;
  }

  emit(): void {
    const elapsedMs = Math.max(0, this.clock.now() - this.startedAt);
    const requestId =
      this.providerId ?? syntheticRequestId('assemblyai', this.input.sessionId, this.attempt);
    const state = this.duration === undefined ? 'estimated' : 'reconciled';
    const sessionSeconds = this.duration ?? elapsedMs / 1000;
    const emitted = this.once.emit({
      provider: 'assemblyai',
      operation: 'stt',
      unit: 'session_seconds',
      quantity: decimal(sessionSeconds),
      state,
      requestId,
      elapsedMs,
    });
    // The audio actually sent, next to the billed (or estimated) session length, so a cost review
    // can tell an idle connection from a long call.
    if (emitted)
      logger.info('stt_usage', {
        sessionId: this.input.sessionId,
        requestId,
        state,
        sessionSeconds,
        audioSeconds: this.audioBytes / bytesPerSecond(this.input.format),
      });
  }
}
