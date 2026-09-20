export type SessionCleanup = (failure: unknown | undefined) => void | Promise<void>;

/** Runs acquired session resources exactly once in strict reverse order. */
export class SessionCleanupStack {
  private readonly cleanups: SessionCleanup[] = [];
  private closing?: Promise<unknown | undefined>;

  defer(cleanup: SessionCleanup): void {
    if (this.closing) throw new Error('session cleanup has already started');
    this.cleanups.push(cleanup);
  }

  close(initialFailure?: unknown): Promise<unknown | undefined> {
    return (this.closing ??= this.drain(initialFailure));
  }

  private async drain(initialFailure?: unknown): Promise<unknown | undefined> {
    let firstFailure = initialFailure;
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup(firstFailure);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    return firstFailure;
  }
}

export function throwFailure(failure: unknown): never {
  throw failure;
}
