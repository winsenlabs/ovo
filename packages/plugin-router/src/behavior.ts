import type { Behavior, SpeechReceipt } from '@winsendotai/ovo-contracts';
import type { RouterCore, RouterReply } from './core.ts';

/**
 * The router as the voice engine's `Behavior` (§7.5). It speaks first; each opening, caller (speech
 * or keypad) and idle turn goes to the `RouterCore`, one at a time. Once the route is decided the
 * router's last line (the connecting line before a handoff, or the end line) is the final one: the
 * behaviour completes on that line's first receipt, completed or interrupted, because a caller who
 * barges in on "Connecting you now" does not undo a committed handoff (§8.3). A final line that
 * never played (its turn was cancelled) is said once more on the next turn; after that, any turn
 * completes the behaviour with nothing said.
 */
export class RouterBehavior implements Behavior {
  private epoch?: number;
  private final?: { line: string; epoch?: number; replayed: boolean };
  private completed = false;
  private disposed = false;
  private active?: AbortController;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly core: RouterCore) {}

  speaksFirst(): boolean {
    return true;
  }

  idleTimeoutMs(): number | undefined {
    return this.core.snapshot.idle?.timeoutMs;
  }

  beginTurn(epoch: number): void {
    this.epoch = epoch;
  }

  respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    const run = this.queue.then(() => this.run(input, variables));
    // swallow-ok: the queue only orders turns; each turn's own promise carries its error.
    this.queue = run.catch(() => undefined);
    return run;
  }

  onPlayback(receipt: SpeechReceipt): void {
    const final = this.final;
    if (!final || this.completed) return;
    if (final.epoch === undefined || receipt.epoch === final.epoch) this.completed = true;
  }

  isComplete(): boolean {
    return this.completed;
  }

  completionReason(): string | undefined {
    return this.completed ? this.core.completionReason() : undefined;
  }

  /** Aborts the turn in flight; a handoff it prepared but did not commit is abandoned. */
  cancel(): void {
    this.active?.abort(new DOMException('router turn cancelled', 'AbortError'));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.core.abandon();
  }

  private async run(input: string, variables: Record<string, unknown>): Promise<string> {
    if (this.disposed || this.completed) return '';
    if (this.final) return this.again(this.final);
    const controller = new AbortController();
    this.active = controller;
    try {
      const reply = await this.dispatch(input, variables, controller.signal);
      if (reply.phase !== 'routing') this.decided(reply.say);
      return reply.say;
    } catch (error) {
      if (controller.signal.aborted) return '';
      throw error;
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  private dispatch(
    input: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RouterReply> {
    switch (variables.inputEvent) {
      case 'opening':
        return this.core.opening(signal);
      case 'idle':
        return this.core.idle(signal);
      case 'dtmf': {
        const digits = typeof variables.digits === 'string' ? variables.digits : input;
        return this.core.turn({ digits }, signal);
      }
      default:
        return this.core.turn({ text: input }, signal);
    }
  }

  private decided(line: string): void {
    this.final = {
      line,
      ...(this.epoch !== undefined ? { epoch: this.epoch } : {}),
      replayed: false,
    };
    if (!line) this.completed = true;
  }

  /** A turn after the decision: the unplayed final line once more, then nothing. */
  private again(final: NonNullable<RouterBehavior['final']>): string {
    if (final.replayed) {
      this.completed = true;
      return '';
    }
    final.replayed = true;
    if (this.epoch !== undefined) final.epoch = this.epoch;
    else delete final.epoch;
    return final.line;
  }
}
