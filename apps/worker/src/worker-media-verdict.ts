type Verdict = 'human' | 'machine' | 'unknown';

/** The carrier's answering-machine verdict, once; a subscriber that arrives later still hears it. */
export class AnsweredByLatch {
  private readonly listeners = new Set<(value: Verdict) => void>();
  private value?: Verdict;

  subscribe(fn: (value: Verdict) => void): () => void {
    const known = this.value;
    if (known) queueMicrotask(() => this.listeners.has(fn) && fn(known));
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  deliver(value: Verdict): void {
    if (this.value) return;
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
}
