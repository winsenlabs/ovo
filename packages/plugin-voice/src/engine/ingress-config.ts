import type { SttConfigurationUpdate, SttSession } from '@winsendotai/ovo-contracts';

/**
 * One call's live STT configuration (STT-4): each update goes to the connected session now, and
 * everything so far goes to any session a reconnect opens later.
 */
export class LiveSttConfiguration {
  private current?: SttConfigurationUpdate;

  /** `refused` is told about a provider's refusal; the call keeps its current endpointing. */
  constructor(private readonly refused: (error: unknown) => void) {}

  /** False when the connected provider fixes its configuration at connect. */
  update(update: SttConfigurationUpdate, session: SttSession | undefined): boolean {
    this.current = { ...this.current, ...update };
    if (!session) return true;
    if (!session.updateConfiguration) return false;
    this.send(session, update);
    return true;
  }

  /** A newly adopted session (first connect or reconnect) gets the configuration so far. */
  adopted(session: SttSession): void {
    if (this.current) this.send(session, this.current);
  }

  private send(session: SttSession, update: SttConfigurationUpdate): void {
    // A dropped socket surfaces on the next write too, where recovery handles it.
    void session.updateConfiguration?.(update).catch(this.refused);
  }
}
