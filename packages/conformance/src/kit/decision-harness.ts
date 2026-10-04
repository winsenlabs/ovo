/**
 * The FixtureNet harness every `decision@1` check drives, and the shared failure assertions. One
 * harness run binds ONE port from the plan's model and replays the plan's exchanges in order, under
 * the egress sentinel, so a plugin that reaches past its `NetPort` is caught by construction.
 */
import {
  validateDecisionExchange,
  type DecisionRequest,
  type DecisionResponse,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet, type FixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import type { DecisionKitContext, DecisionScriptPlan } from './decision-support.ts';
import type { Failures } from './runner.ts';

export interface DecisionCallResult {
  response?: DecisionResponse;
  error?: unknown;
}

export interface DecisionRun {
  net: FixtureNet;
  usage: UsageMeter[];
  attempts: readonly string[];
  results: DecisionCallResult[];
  /** The request bodies the port really put on the wire, in order. */
  bodies: string[];
  /** Hosts the port reached, and the hosts its own fixture declares. */
  reached: string[];
  declared: string[];
  setupError?: unknown;
}

export interface DriveOptions {
  /** 0 collapses scripted delays; 1 makes them real, for abort timing. */
  clockScale?: number;
  controllerFor?: (index: number) => AbortController;
}

export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Builds the scripts from the plan, binds one port and drives every exchange in order. */
export async function driveDecision(
  context: DecisionKitContext,
  plan: DecisionScriptPlan,
  options: DriveOptions = {},
): Promise<DecisionRun> {
  const clock = acceleratedClock(options.clockScale ?? 0);
  const scripts = context.options.template?.(plan);
  const net = createFixtureNet(scripts ?? [], { clock });
  const usage: UsageMeter[] = [];
  const results: DecisionCallResult[] = [];
  let setupError: unknown = scripts
    ? undefined
    : new Error('no decision fixture template was supplied');
  const attempts = await withEgressSentinel(async (sentinel) => {
    if (!setupError)
      try {
        const port = await context.factory({
          net,
          clock,
          usage: (meter) => usage.push(meter),
          model: plan.model,
        });
        for (const [index, exchange] of plan.exchanges.entries()) {
          const controller = options.controllerFor?.(index) ?? new AbortController();
          try {
            const response = await port.decide(exchange.request, { signal: controller.signal });
            results.push({ response });
          } catch (error) {
            results.push({ error });
          }
        }
      } catch (error) {
        setupError = error;
      }
    return sentinel.attempts;
  });
  const http = net.log.filter((entry) => entry.kind === 'http');
  return {
    net,
    usage,
    attempts,
    results,
    bodies: http.map((entry) => (typeof entry.data === 'string' ? entry.data : '')),
    reached: [...new Set(net.log.map((entry) => entry.host))],
    declared: [...new Set((scripts ?? []).map((script) => script.host))],
    setupError,
  };
}

/** Folds the FixtureNet's own verdict in: a mismatch, a leak or an unconsumed step is a failure. */
export function netFailures(f: Failures, run: DecisionRun, where: string, pending = true): void {
  if (run.setupError)
    f.add(`${where}: the port could not be bound: ${describeError(run.setupError)}`);
  f.add(...run.net.mismatches.map((error) => `${where}: ${error.message}`));
  if (pending)
    f.add(...run.net.pending().map((step) => `${where}: unconsumed ${step.description}`));
  f.expect(
    run.attempts.length === 0,
    `${where}: network bypassed the NetPort: ${run.attempts.join(', ')}`,
  );
  for (const host of run.reached)
    f.expect(
      run.declared.includes(host),
      `${where}: reached ${host}, but the plugin's fixture declares only ${run.declared.join(', ') || '(nothing)'}`,
    );
}

/** The response of exchange `index`, or a failure naming why there is none. */
export function answerOf(
  f: Failures,
  run: DecisionRun,
  index: number,
  where: string,
): DecisionResponse | undefined {
  const result = run.results[index];
  if (!result) {
    f.add(`${where}: decide() never returned for exchange ${index}`);
    return undefined;
  }
  if (result.error !== undefined) {
    f.add(`${where}: decide() rejected: ${describeError(result.error)}`);
    return undefined;
  }
  return result.response;
}

/** `validateDecisionExchange` on the request the kit built and the response the port returned. */
export function exchangeFailures(
  f: Failures,
  request: DecisionRequest,
  response: unknown,
  where: string,
): void {
  try {
    validateDecisionExchange(request, response);
  } catch (error) {
    f.add(`${where}: ${describeError(error).replaceAll('\n', ' ')}`);
  }
}

/** The port must REFUSE, not repair and not pass through, a provider reply that breaks `what`. */
export function refusalFailures(f: Failures, run: DecisionRun, index: number, what: string): void {
  const result = run.results[index];
  if (!result) {
    f.add(`${what}: decide() was never called`);
    return;
  }
  f.expect(
    result.error !== undefined,
    `${what}: decide() resolved instead of refusing the provider reply`,
  );
}
