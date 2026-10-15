/**
 * Audio handed from socket callbacks to one async reader. `end` lets the reader drain what is
 * queued and then finish (or throw the failure); an aborted read signal stops it at once.
 */
export class AudioQueue {
  private readonly items: Uint8Array[] = [];
  private finished = false;
  private failure?: Error;
  private notify?: () => void;

  get ended(): boolean {
    return this.finished;
  }

  push(bytes: Uint8Array): void {
    if (this.finished || !bytes.byteLength) return;
    this.items.push(bytes);
    this.poke();
  }

  end(error?: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.failure = error;
    this.poke();
  }

  /** Drops whatever is queued and not yet read. */
  discard(): void {
    this.items.length = 0;
    this.poke();
  }

  async *read(signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const onAbort = () => this.poke();
    signal.addEventListener('abort', onAbort);
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = this.items.shift();
        if (next) yield next;
        else if (this.finished) {
          if (this.failure) throw this.failure;
          return;
        } else await new Promise<void>((wake) => (this.notify = wake));
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private poke(): void {
    const wake = this.notify;
    this.notify = undefined;
    wake?.();
  }
}
