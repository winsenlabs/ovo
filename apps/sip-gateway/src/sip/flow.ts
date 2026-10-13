import type { Clock } from '@winsendotai/ovo-contracts';
import type { SipMessage } from './message.ts';

/** Where a message came from or goes to; a TCP flow may pin one connection. */
export interface Flow {
  transport: 'udp' | 'tcp';
  address: string;
  port: number;
  connectionId?: number;
}

export type Send = (message: SipMessage, flow: Flow) => void;

/** RFC 3261 Table 4. Tests shrink nothing: they drive a fake clock instead. */
export interface SipTimers {
  t1: number;
  t2: number;
  t4: number;
}

export const DEFAULT_TIMERS: SipTimers = Object.freeze({ t1: 500, t2: 4_000, t4: 5_000 });

export interface TransactionContext {
  send: Send;
  clock: Clock;
  timers: SipTimers;
}

export const reliable = (flow: Flow) => flow.transport === 'tcp';

/** One cancellable timer slot per name, so a state change can stop exactly what it started. */
export class TimerSet {
  private readonly cancels = new Map<string, () => void>();

  constructor(private readonly clock: Clock) {}

  start(name: string, ms: number, fn: () => void): void {
    this.stop(name);
    this.cancels.set(
      name,
      this.clock.setTimeout(() => {
        this.cancels.delete(name);
        fn();
      }, ms),
    );
  }

  stop(name: string): void {
    this.cancels.get(name)?.();
    this.cancels.delete(name);
  }

  stopAll(): void {
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
  }
}
