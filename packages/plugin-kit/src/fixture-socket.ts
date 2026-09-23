import type { Clock, NetFixtureStep, WebSocketLike } from '@winsendotai/ovo-contracts';
import type { FixtureStep } from './fixture-match.ts';
import {
  FixtureMismatchError,
  decodeBase64,
  describeFrame,
  describeStep,
  matchesFrame,
} from './fixture-match.ts';

type WsSend = Extract<NetFixtureStep, { expect: 'ws-send' }>;

/** A script cursor. A socket owns it from its `ws-open` until the next open or http step. */
export interface ScriptRun {
  readonly host: string;
  readonly source: string;
  readonly steps: readonly FixtureStep[];
  index: number;
  /** A `repeat: 'until-next'` step that keeps accepting frames after the cursor moved on. */
  background?: WsSend;
}

export interface FixtureSocketHooks {
  clock: Pick<Clock, 'setTimeout'>;
  log(kind: 'ws-in' | 'ws-out' | 'ws-close', data?: string | Uint8Array): void;
  mismatch(error: FixtureMismatchError): void;
  listenerError(error: unknown): void;
}

type Listener = (...args: never[]) => void;

/** The client side of one scripted WebSocket. Server steps run from microtasks, never inside `send`. */
export class FixtureSocket implements WebSocketLike {
  private state: 0 | 1 | 2 | 3 = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  private waiting = false;

  constructor(
    private readonly run: ScriptRun,
    private readonly hooks: FixtureSocketHooks,
  ) {
    queueMicrotask(() => {
      if (this.state !== 0) return;
      this.state = 1;
      this.emit('open');
      this.pump();
    });
  }

  get readyState(): 0 | 1 | 2 | 3 {
    return this.state;
  }

  on(event: 'open' | 'message' | 'close' | 'error', fn: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(event, set);
    return () => {
      set.delete(fn);
    };
  }

  send(data: string | Uint8Array): void {
    if (this.state !== 1) throw new Error('WebSocket is not open');
    this.hooks.log('ws-out', data);
    const run = this.run;
    const head = run.steps[run.index];
    if (head && 'expect' in head && head.expect === 'ws-send') {
      if (matchesFrame(head, data)) return this.accept(head);
      const next = run.steps[run.index + 1];
      if (head.repeat && next && 'expect' in next && next.expect === 'ws-send') {
        if (matchesFrame(next, data)) {
          run.index += 1;
          return this.accept(next);
        }
      }
    }
    if (run.background && matchesFrame(run.background, data)) return;
    const error = new FixtureMismatchError(
      run.host,
      describeStep(head, run.index),
      describeFrame(data),
      run.source,
    );
    this.hooks.mismatch(error);
    throw error;
  }

  close(code?: number, reason?: string): void {
    if (this.state >= 2) return;
    const head = this.run.steps[this.run.index];
    const actualCode = code ?? 1005;
    const actualReason = reason ?? '';
    if (head && 'close' in head) {
      if (head.close.code !== actualCode || (head.close.reason ?? '') !== actualReason) {
        const error = new FixtureMismatchError(
          this.run.host,
          describeStep(head, this.run.index),
          `close ${actualCode} ${actualReason}`,
          this.run.source,
        );
        this.hooks.mismatch(error);
        throw error;
      }
      this.run.index += 1;
    }
    this.state = 2;
    this.run.background = undefined;
    queueMicrotask(() => this.finish(actualCode, actualReason));
  }

  private accept(step: WsSend): void {
    this.run.index += 1;
    this.run.background = step.repeat ? step : undefined;
    if (!this.waiting) queueMicrotask(() => this.pump());
  }

  private finish(code: number, reason: string): void {
    if (this.state === 3) return;
    this.state = 3;
    this.hooks.log('ws-close', `${code} ${reason}`);
    this.emit('close', code, reason);
  }

  /** Runs server steps (send, delay, close) until the script waits for the client or moves on. */
  private pump(): void {
    const run = this.run;
    while (this.state === 1 && !this.waiting) {
      const step = run.steps[run.index];
      if (!step || 'expect' in step) return;
      if ('delayMs' in step) {
        this.waiting = true;
        this.hooks.clock.setTimeout(() => {
          this.waiting = false;
          run.index += 1;
          this.pump();
        }, step.delayMs);
        return;
      }
      run.index += 1;
      if ('close' in step) {
        this.state = 2;
        run.background = undefined;
        this.finish(step.close.code, step.close.reason ?? '');
        return;
      }
      const payload = typeof step.send === 'string' ? step.send : decodeBase64(step.send.base64);
      this.hooks.log('ws-in', payload);
      this.emit('message', payload, typeof payload !== 'string');
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as (...values: unknown[]) => void)(...args);
      } catch (error) {
        this.hooks.listenerError(error);
      }
    }
  }
}
