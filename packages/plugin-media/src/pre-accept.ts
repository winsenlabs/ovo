import { bytesPerSecond, type AudioFormat } from '@winsendotai/ovo-contracts';

/** One standard 20 ms MULAW_8K frame is 160 bytes. */
export const MIN_PRE_ACCEPT_MS = 20;

/** Events retain their arrival order until the owning worker accepts the session. */
export class PreAcceptBuffer<T> {
  private readonly entries: { event: T; audioBytes: number }[] = [];
  private audioBytes = 0;
  private readonly maximumAudioBytes: number;

  constructor(
    format: AudioFormat,
    durationMs = 3_000,
    private readonly maximumEvents = 1_024,
  ) {
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_PRE_ACCEPT_MS)
      throw new Error('pre-accept duration must be at least 20 ms');
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1)
      throw new Error('pre-accept event limit must be a positive integer');
    const rate = bytesPerSecond(format);
    // The fixed 3-second byte ceiling remains even when an operator raises the time budget.
    this.maximumAudioBytes = Math.min(
      Math.floor((rate * durationMs) / 1_000),
      2 * rate * 3,
      196_608,
    );
  }

  get bufferedAudioBytes(): number {
    return this.audioBytes;
  }

  /** False means the session must be refused; an event is never silently discarded. */
  push(event: T, audioBytes = 0): boolean {
    if (!Number.isSafeInteger(audioBytes) || audioBytes < 0)
      throw new Error('pre-accept audio byte count is invalid');
    if (
      this.entries.length >= this.maximumEvents ||
      this.audioBytes + audioBytes > this.maximumAudioBytes
    )
      return false;
    this.entries.push({ event, audioBytes });
    this.audioBytes += audioBytes;
    return true;
  }

  drain(): T[] {
    const events = this.entries.splice(0).map(({ event }) => event);
    this.audioBytes = 0;
    return events;
  }
}
