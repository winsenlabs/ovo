import { fork, type ChildProcess } from 'node:child_process';
import type { SessionGraphRelease } from '@winsendotai/ovo-session-host';
import type { CallerScript, FixtureCallEvent, FixtureCallResult } from './types.ts';
import { fixtureCallsEnabled } from './request.ts';

export interface FixtureChildJob {
  callId: string;
  release: SessionGraphRelease;
  callerScript?: CallerScript | 'default';
}

export type FixtureChildMessage =
  | { type: 'event'; event: FixtureCallEvent }
  | { type: 'result'; result: FixtureCallResult }
  | { type: 'error'; message: string };

export interface TestCallRuntimeOptions {
  enabled?: boolean;
  nodeEnv?: string;
  maxConcurrent?: number;
  wallTimeoutMs?: number;
  modulePath?: string;
  forkChild?: (modulePath: string, args: string[]) => ChildProcess;
  execute?: (
    job: FixtureChildJob,
    onEvent: (event: FixtureCallEvent) => void | Promise<void>,
  ) => Promise<FixtureCallResult>;
}

/** A bounded process boundary. API callers receive a call ID before the child completes. */
export class TestCallRuntime {
  private active = 0;
  readonly enabled: boolean;
  readonly wallTimeoutMs: number;

  constructor(private readonly options: TestCallRuntimeOptions = {}) {
    this.enabled = fixtureCallsEnabled(options);
    this.wallTimeoutMs = options.wallTimeoutMs ?? 120_000;
  }

  get activeCount(): number {
    return this.active;
  }

  /** Reserve before durable call creation, so capacity refusal leaves no call row. */
  reserve(): {
    start: (
      job: FixtureChildJob,
      onEvent?: (event: FixtureCallEvent) => void | Promise<void>,
    ) => Promise<FixtureCallResult>;
    cancel: () => void;
  } {
    if (!this.enabled) throw new Error('fixture_calls_disabled');
    if (this.active >= (this.options.maxConcurrent ?? 2)) throw new Error('fixture_calls_capacity');
    this.active++;
    let used = false;
    const cancel = () => {
      if (used) return;
      used = true;
      this.active--;
    };
    return {
      cancel,
      start: (job, onEvent = () => undefined) => {
        if (used) throw new Error('Fixture call reservation was already used');
        used = true;
        try {
          const result = this.options.execute
            ? Promise.resolve().then(() => this.options.execute!(job, onEvent))
            : this.runChild(job, onEvent);
          return result.finally(() => {
            this.active--;
          });
        } catch (error) {
          this.active--;
          throw error;
        }
      },
    };
  }

  start(
    job: FixtureChildJob,
    onEvent: (event: FixtureCallEvent) => void | Promise<void> = () => undefined,
  ): Promise<FixtureCallResult> {
    return this.reserve().start(job, onEvent);
  }

  private runChild(
    job: FixtureChildJob,
    onEvent: (event: FixtureCallEvent) => void | Promise<void>,
  ): Promise<FixtureCallResult> {
    const modulePath = this.options.modulePath ?? process.argv[1];
    if (!modulePath) throw new Error('Fixture child module path is unavailable');
    const child = this.options.forkChild
      ? this.options.forkChild(modulePath, ['--ovo-fixture-call-child'])
      : fork(modulePath, ['--ovo-fixture-call-child'], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
    return new Promise((resolve, reject) => {
      let settled = false;
      let terminal = false;
      let writes = Promise.resolve();
      const settle = (error?: Error, result?: FixtureCallResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeAllListeners('message');
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
        if (child.connected) child.disconnect();
        if (error) child.kill();
        if (error) reject(error);
        else resolve(result!);
      };
      const finish = (error?: Error, result?: FixtureCallResult) => {
        if (terminal) return;
        terminal = true;
        if (error) settle(error);
        else void writes.then(() => settle(undefined, result), settle);
      };
      const timeout = setTimeout(
        () => settle(new Error('Fixture call exceeded the 120 second wall timeout')),
        this.wallTimeoutMs,
      );
      child.on('message', (value: FixtureChildMessage) => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'event') {
          writes = writes.then(() => onEvent(value.event));
          void writes.catch((cause: unknown) =>
            finish(cause instanceof Error ? cause : new Error(String(cause))),
          );
        } else if (value.type === 'result') finish(undefined, value.result);
        else if (value.type === 'error') finish(new Error(value.message));
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) =>
        finish(new Error(`Fixture call child exited before completion (${code ?? signal})`)),
      );
      try {
        child.send({ type: 'start', job });
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}

/** The child accepts exactly one job and exits; it never starts the HTTP server. */
export function runFixtureCallChild(execute: TestCallRuntimeOptions['execute']): void {
  if (!execute || !process.send) throw new Error('Fixture child requires an IPC executor');
  process.once('message', (value: { type?: string; job?: FixtureChildJob }) => {
    if (value?.type !== 'start' || !value.job) {
      process.send?.({ type: 'error', message: 'Invalid fixture child request' }, () =>
        process.exit(1),
      );
      return;
    }
    void execute(value.job, (event) => {
      process.send?.({ type: 'event', event });
    }).then(
      (result) => process.send?.({ type: 'result', result }, () => process.exit(0)),
      (error) =>
        process.send?.(
          {
            type: 'error',
            message: error instanceof Error ? error.message : 'Fixture call failed',
          },
          () => process.exit(1),
        ),
    );
  });
}
