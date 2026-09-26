import type { SttEvent } from '@winsendotai/ovo-contracts';

/**
 * Agents 1.9.0 skips userTurnCompleted during non-interruptible speech (agent_activity:2975).
 * Preserve provider events until the exact confirmation receipt and SpeechHandle are settled.
 * Disclosure input is intentionally discarded. Overflow fails closed instead of losing a yes.
 */
export class SttGate {
  private mode: 'open' | 'buffer' | 'discard' = 'open';
  private readonly pending: { event: SttEvent; deliver: (event: SttEvent) => void }[] = [];
  private closed = false;
  constructor(private readonly overflow: () => void) {}
  accept(event: SttEvent, deliver: (event: SttEvent) => void): void {
    if (this.closed || this.mode === 'discard') return;
    if (this.mode === 'open') {
      deliver(event);
      return;
    }
    if (this.pending.length >= 256) {
      this.close();
      this.overflow();
      return;
    }
    this.pending.push({ event: structuredClone(event), deliver });
  }
  set(mode: 'open' | 'buffer' | 'discard'): void {
    if (this.closed) return;
    this.mode = mode;
    if (mode === 'discard') this.pending.length = 0;
    if (mode === 'open') for (const item of this.pending.splice(0)) item.deliver(item.event);
  }
  close(): void {
    this.closed = true;
    this.pending.length = 0;
  }
}
