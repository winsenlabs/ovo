import type { Behavior, Clock } from '@winsendotai/ovo-contracts';
import type { VoiceEventBus } from './events.ts';

export interface IdleDriver {
  /** True when no turn is running or queued and the call is not ending. */
  quiet(): boolean;
  /** Runs the idle turn, whose line the behaviour chooses. */
  run(turnId: string): void;
}

/**
 * Times caller silence for a behaviour that handles it itself (AGT-11). Armed when the agent has
 * finished speaking and nothing else is running; any sign of the caller (speech activity, a
 * transcript, a key press) disarms it, and the end of their speech arms it again. When it fires,
 * the driver runs an idle turn, whose line the behaviour chooses.
 */
export class IdleWatch {
  private cancelTimer?: () => void;
  private readonly unsubscribe: () => void;
  private silences = 0;

  /** A watch for a behaviour that times caller silence itself; none for any other. */
  static for(
    behavior: Behavior & { idleTimeoutMs?(): number | undefined },
    clock: Pick<Clock, 'setTimeout'>,
    events: VoiceEventBus,
    driver: IdleDriver,
  ): IdleWatch | undefined {
    const timeoutMs = behavior.idleTimeoutMs?.();
    return timeoutMs === undefined ? undefined : new IdleWatch(clock, timeoutMs, events, driver);
  }

  constructor(
    private readonly clock: Pick<Clock, 'setTimeout'>,
    private readonly timeoutMs: number,
    private readonly events: VoiceEventBus,
    private readonly driver: IdleDriver,
  ) {
    this.unsubscribe = events.onEvent((event) => {
      if (event.type === 'vad.stop') this.arm();
      else if (
        event.type === 'vad.start' ||
        event.type === 'dtmf' ||
        (event.type === 'stt' &&
          event.event.type === 'transcript' &&
          event.event.segment.text.trim())
      )
        this.cancel();
    });
  }

  arm(): void {
    this.cancel();
    if (!this.driver.quiet()) return;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      if (!this.driver.quiet()) return;
      const turnId = `idle-${++this.silences}`;
      this.events.emit({ type: 'user.turn', phase: 'idle', turnId });
      this.driver.run(turnId);
    }, this.timeoutMs);
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe();
  }
}
