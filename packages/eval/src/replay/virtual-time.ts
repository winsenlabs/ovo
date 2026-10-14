// Virtual time for an offline replay: a four-minute call replays in seconds and the same way every
// time. It is the conformance kit's FakeClock, read in epoch ms like Date.now(), because the engine
// mixes the two (the ingress stamps STT events with Date.now(); the carrier and detector use the
// clock). Parts of the pipeline use the globals (the behaviour's speculation debounce, abortable
// delays), so while a replay runs `install()` routes setTimeout, setInterval and Date.now through
// it too. Promise callbacks still run for real: the kit's advanceAsync yields between timers.
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { Clock } from '@winsendotai/ovo-contracts';

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  now: Date.now,
};

interface Handle {
  readonly id: number;
  ref(): Handle;
  unref(): Handle;
  hasRef(): boolean;
  refresh(): Handle;
  [Symbol.toPrimitive](): number;
}

export class VirtualTime implements Clock {
  private readonly fake = new FakeClock();
  private readonly cancels = new Map<number, () => void>();
  private nextId = 1;
  private installed = false;

  /** `epochMs`: what now() and Date.now() read at call time 0. */
  constructor(readonly epochMs = Date.UTC(2026, 9, 14)) {}

  now(): number {
    return this.epochMs + this.fake.now();
  }

  /** Ms since call time 0. */
  callTime(): number {
    return this.fake.now();
  }

  setTimeout(fn: () => void, ms: number): () => void {
    return this.fake.setTimeout(fn, Number.isFinite(ms) ? Math.max(0, ms) : 0);
  }

  private handle(arm: (id: number) => () => void): Handle {
    const id = this.nextId++;
    this.cancels.set(id, arm(id));
    const handle: Handle = {
      id,
      ref: () => handle,
      unref: () => handle,
      hasRef: () => true,
      refresh: () => handle,
      [Symbol.toPrimitive]: () => id,
    };
    return handle;
  }

  private clear(value: unknown): void {
    const id = typeof value === 'object' && value !== null ? (value as Handle).id : Number(value);
    this.cancels.get(id)?.();
    this.cancels.delete(id);
  }

  /** Routes the timer globals and Date.now through this clock until `uninstall()`. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    type Callback = (...args: unknown[]) => void;
    const once = (fn: Callback, ms = 0, args: unknown[] = []) =>
      this.handle((id) =>
        this.setTimeout(() => {
          this.cancels.delete(id);
          fn(...args);
        }, ms),
      );
    const every = (fn: Callback, ms = 1, args: unknown[] = []) =>
      this.handle((id) => {
        const tick = () => {
          this.cancels.set(id, this.setTimeout(tick, Math.max(1, ms)));
          fn(...args);
        };
        return this.setTimeout(tick, Math.max(1, ms));
      });
    Object.assign(globalThis, {
      setTimeout: (fn: Callback, ms?: number, ...args: unknown[]) => once(fn, ms, args),
      setInterval: (fn: Callback, ms?: number, ...args: unknown[]) => every(fn, ms, args),
      clearTimeout: (id: unknown) => this.clear(id),
      clearInterval: (id: unknown) => this.clear(id),
    });
    Date.now = () => Math.floor(this.now());
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    const { now, ...timers } = real;
    Object.assign(globalThis, timers);
    Date.now = now;
  }

  /** Runs every timer due up to call time `target`, letting promises settle around each. */
  async runUntil(target: number): Promise<void> {
    await this.fake.advanceAsync(Math.max(0, target - this.fake.now()));
  }
}
