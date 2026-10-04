/** Own callback promises immediately, including failures before the engine has started. */
export class FixtureEffects {
  private readonly pending = new Set<Promise<void>>();
  private failed = false;
  private error: unknown;
  private fail!: (error: unknown) => void;
  private readonly failure = new Promise<unknown>((resolve) => {
    this.fail = resolve;
  });

  run(action: () => void | Promise<void>): void {
    try {
      const observed = Promise.resolve(action()).then(
        () => {
          this.pending.delete(observed);
        },
        (error: unknown) => {
          this.pending.delete(observed);
          this.reject(error);
        },
      );
      this.pending.add(observed);
    } catch (error) {
      this.reject(error);
    }
  }

  async wait<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.failed) throw this.error;
    return Promise.race([
      action(),
      this.failure.then((error) => {
        throw error;
      }),
    ]);
  }

  async drain(): Promise<void> {
    do {
      await this.wait(() => Promise.all([...this.pending]));
    } while (this.pending.size);
  }

  private reject(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.error = error;
    this.fail(error);
  }
}
