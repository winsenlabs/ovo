import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Cap, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import {
  fixtureCarrierInboundFrame,
  runFixtureCall,
  withFixtureEgressSentinel,
} from '@winsendotai/ovo-fixture-calls';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadInstalledSessionExtensions } from '@winsendotai/ovo-session-host';
import { createFixtureRecordingPort } from './recording-runtime.ts';
import type {
  CallerScript,
  FixtureCallEvent,
  FixtureCallResult,
} from '@winsendotai/ovo-fixture-calls';
import type { SessionGraphRelease } from '@winsendotai/ovo-session-host';

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

export function fixtureCallsEnabled(input: { enabled?: boolean; nodeEnv?: string }): boolean {
  return input.enabled ?? input.nodeEnv !== 'production';
}

export function fixtureCallsEnvironmentEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OVO_FIXTURE_TEST_CALLS must be true or false');
}

export function idempotentFixtureCallId(workspaceId: string, agentId: string, key: string): string {
  const bytes = createHash('sha256').update(`${workspaceId}\0${agentId}\0${key}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
        if (value.type === 'event') writes = writes.then(() => onEvent(value.event));
        else if (value.type === 'result') finish(undefined, value.result);
        else if (value.type === 'error') finish(new Error(value.message));
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) =>
        finish(new Error(`Fixture call child exited before completion (${code ?? signal})`)),
      );
      child.send({ type: 'start', job });
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

/** Resolves the selected carrier inside the child under the fixture egress fence. */
export async function executeFixtureChildJob(
  job: FixtureChildJob,
  onEvent: (event: FixtureCallEvent) => void | Promise<void>,
): Promise<FixtureCallResult> {
  return withFixtureEgressSentinel(async () => {
    const distribution = await loadDistribution({
      role: 'api',
      profile: process.env.OVO_DEPLOYMENT_PROFILE === 'fargate' ? 'fargate' : 'compose',
      env: process.env,
    });
    const installedExtensions = await loadInstalledSessionExtensions(
      process.env.OVO_PLUGIN_MODULES,
    );
    const selected = job.release.selections?.carrier;
    if (!selected) throw new Error('fixture_unavailable: release has no selected carrier');
    const definition = distribution.catalog.find((item) => item.manifest.id === selected.pluginId);
    if (!definition || definition.manifest.version !== selected.version)
      throw new Error(
        `fixture_unavailable: selected carrier is not installed at ${selected.version}`,
      );
    if (
      definition.manifest.scope !== 'process' ||
      !manifestKeys(definition.manifest).provides.some((entry) => entry.key === Cap.carrierIngress)
    )
      throw new Error('fixture_unavailable: selected carrier has no ingress serializer');
    const carrier = await compose([{ id: selected.pluginId }], [definition], {
      scope: 'process',
      fixtures: true,
      net: createFixtureNet([]),
      enforcement: 'enforce',
    });
    try {
      const provider = manifestKeys(definition.manifest).manifest.provider;
      const ingress = carrier.all(Cap.carrierIngress).get(provider ?? selected.pluginId) as
        CarrierIngress | undefined;
      if (!ingress)
        throw new Error('fixture_unavailable: selected carrier did not provide ingress');
      const inboundFrame = fixtureCarrierInboundFrame(ingress);
      if (!inboundFrame)
        throw new Error(
          `fixture_unavailable: ${selected.pluginId} has no inbound fixture frame builder`,
        );
      const format = ingress.capabilities.media.formats[0];
      if (!format) throw new Error('fixture_unavailable: selected carrier has no recording format');
      return await runFixtureCall({
        callId: job.callId,
        release: job.release,
        registry: new PluginRegistry(distribution.catalog),
        fixtures: distribution.fixtures,
        fixtureTemplates: distribution.fixtureTemplates,
        carrier: { pluginId: selected.pluginId, ingress, inboundFrame },
        callerScript: job.callerScript,
        defaults: distribution.defaults,
        installedExtensions,
        parent: carrier,
        ...(job.release.config.recording ? { recording: createFixtureRecordingPort(format) } : {}),
        telemetry: { onEvent },
      }).done;
    } finally {
      await carrier.dispose();
    }
  });
}
