import type { EventSink } from '@winsendotai/ovo-contracts';
import type {
  RouteLines,
  RoutingHost,
  RoutingNode,
  RoutingReleaseSnapshot,
  RoutingTarget,
  SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import type { EngineRunners, RouteTurn } from './engines/index.ts';
import { evaluateTurn, type EvaluateEnv } from './evaluate.ts';
import { RouteRecorder } from './events.ts';
import { releaseDefault, runFallback, type FallbackResult } from './fallback.ts';
import { BUILT_IN_LINES, pickLine } from './lines.ts';
import {
  cursorOf,
  initialState,
  limitReason,
  nodeMap,
  remember,
  type RouterState,
} from './state.ts';
import { attemptTarget, type Attempt, type RouteOutcome } from './targets.ts';
import { completionReasonOf, finishLine, recordFinish } from './finish.ts';

export interface RouterPorts {
  host: RoutingHost;
  handoff: SegmentHandoffPort;
  /** One runner per engine kind: `createEngineRunners` in production, scripted in a simulator. */
  runners: EngineRunners;
  events?: EventSink;
  /** The router agent's IANA zone, which a promised callback's due time is recorded in. */
  timezone?: string;
}

/** `routing` until the route is decided; then `announcing` (a handoff) or `ended` (end, callback). */
export type RouterPhase = 'routing' | 'announcing' | 'ended';

export interface RouterReply {
  say: string;
  phase: RouterPhase;
}

/**
 * The router's whole conversation logic (§7.5), free of IO: the host, the handoff port and the
 * engines are injected, and time is `host.now()`. A behaviour adapter, a simulator or the eval
 * harness drives it with `opening`, `turn` and `idle`; each returns what the router says and the
 * phase it is now in. Calls must not overlap (the adapter serialises them).
 */
export class RouterCore {
  readonly recorder: RouteRecorder;
  private readonly state: RouterState;
  private readonly nodes: ReadonlyMap<string, RoutingNode>;
  private phaseValue: RouterPhase = 'routing';
  private outcomeValue?: RouteOutcome;
  /** A prepared handoff not yet committed: abandoned if the turn is cancelled. */
  private pending?: string;

  constructor(
    readonly snapshot: RoutingReleaseSnapshot,
    private readonly ports: RouterPorts,
  ) {
    this.recorder = new RouteRecorder(ports.events);
    this.state = initialState(snapshot);
    this.nodes = nodeMap(snapshot);
  }

  get phase(): RouterPhase {
    return this.phaseValue;
  }

  get outcome(): RouteOutcome | undefined {
    return this.outcomeValue;
  }

  /** `route:<agent|end|callback>:<path joined by '>'>`, at most 200 characters, once decided. */
  completionReason(): string | undefined {
    return this.outcomeValue && completionReasonOf(this.outcomeValue);
  }

  /** The opening turn: instant engines may decide at once; otherwise the greeting. */
  opening(signal: AbortSignal): Promise<RouterReply> {
    return this.guard(async () => {
      if (this.phaseValue !== 'routing') return this.reply('');
      this.start();
      const evaluation = await evaluateTurn(this.state, undefined, this.env(signal));
      if (evaluation.kind === 'target')
        return this.route(evaluation.node, evaluation.target, signal);
      const greeting = this.line(this.snapshot.greeting);
      const ask = evaluation.kind === 'ask' && evaluation.node.ask;
      return this.say(ask ? `${greeting} ${this.line(ask)}` : greeting);
    });
  }

  /** A caller turn: speech (`text`) or keypad (`digits`). */
  turn(input: RouteTurn, signal: AbortSignal): Promise<RouterReply> {
    return this.guard(async () => {
      if (this.phaseValue !== 'routing') return this.reply('');
      this.start();
      this.state.turns += 1;
      this.state.idles = 0;
      const limited = await this.limit(signal);
      if (limited) return limited;
      const evaluation = await evaluateTurn(this.state, input, this.env(signal));
      remember(this.state, { role: 'caller', text: input.text ?? input.digits ?? '' });
      if (evaluation.kind === 'target')
        return this.route(evaluation.node, evaluation.target, signal);
      if (evaluation.kind === 'ask' && evaluation.node.ask)
        return this.say(this.line(evaluation.node.ask));
      const clarify = evaluation.kind === 'undecided' ? evaluation.clarify : undefined;
      return this.fallback(evaluation.node, signal, { clarify });
    });
  }

  /** The caller said nothing for the idle timeout: an idle prompt, then the node's chain. */
  idle(signal: AbortSignal): Promise<RouterReply> {
    return this.guard(async () => {
      if (this.phaseValue !== 'routing') return this.reply('');
      this.start();
      this.state.turns += 1;
      const limited = await this.limit(signal);
      if (limited) return limited;
      const prompt = this.snapshot.idle?.prompts[this.state.idles];
      this.state.idles += 1;
      if (prompt) return this.say(this.line(prompt));
      return this.fallback(this.nodes.get(this.state.node)!, signal, {});
    });
  }

  /** Abandons a prepared handoff that was never committed. Idempotent. */
  async abandon(): Promise<void> {
    const id = this.pending;
    this.pending = undefined;
    // swallow-ok: abandon is idempotent cleanup; the host disposes the graph either way.
    if (id) await this.ports.handoff.abandon(id).catch(() => undefined);
  }

  private async guard(work: () => Promise<RouterReply>): Promise<RouterReply> {
    try {
      return await work();
    } catch (error) {
      await this.abandon();
      throw error;
    }
  }

  private start(): void {
    this.state.startedAt ??= this.ports.host.now();
  }

  private env(signal: AbortSignal): EvaluateEnv {
    const { snapshot, nodes, recorder } = this;
    return { snapshot, nodes, recorder, runners: this.ports.runners, now: this.now, signal };
  }

  private readonly now = () => this.ports.host.now();

  private line(lines: RouteLines): string {
    return pickLine(lines, this.state.context.language, this.snapshot.language.default);
  }

  private attempt(signal: AbortSignal): (target: RoutingTarget) => Promise<Attempt> {
    return (target) =>
      attemptTarget(target, {
        snapshot: this.snapshot,
        host: this.ports.host,
        handoff: this.ports.handoff,
        context: this.state.context,
        path: this.state.path,
        prepared: (handoffId) => (this.pending = handoffId),
        signal,
      });
  }

  private chainInput(node: RoutingNode, signal: AbortSignal) {
    const defaultTarget: RoutingTarget = { kind: 'agent', agent: this.snapshot.defaultTarget };
    return {
      node,
      turn: this.state.turns,
      recorder: this.recorder,
      defaultTarget,
      finalLine: this.line(BUILT_IN_LINES.end),
      attempt: this.attempt(signal),
    };
  }

  /** The turn and time limits (§7.5 step 2): past either, the release default target. */
  private async limit(signal: AbortSignal): Promise<RouterReply | undefined> {
    const reason = limitReason(this.state, this.snapshot.limits, this.ports.host.now());
    if (!reason) return undefined;
    const node = this.nodes.get(this.state.node)!;
    const turn = this.state.turns;
    this.recorder.fallback({
      turn,
      node: node.id,
      step: 'limit',
      result: 'taken',
      attempt: 1,
      reason,
    });
    return this.finish(node, await releaseDefault(this.chainInput(node, signal)), signal);
  }

  private async route(node: RoutingNode, target: RoutingTarget, signal: AbortSignal) {
    const attempt = await this.attempt(signal)(target);
    if (attempt.ok)
      return this.finish(node, { kind: 'resolved', resolution: attempt.resolution }, signal);
    return this.fallback(node, signal, { noReask: attempt.reason });
  }

  private async fallback(
    node: RoutingNode,
    signal: AbortSignal,
    options: { clarify?: string; noReask?: string },
  ): Promise<RouterReply> {
    const result = await runFallback({
      ...this.chainInput(node, signal),
      cursor: cursorOf(this.state, node.id),
      ...(options.noReask !== undefined ? { noReask: options.noReask } : {}),
      reaskLine: (step) =>
        options.clarify ??
        (step.line ? this.line(step.line) : node.ask ? this.line(node.ask) : undefined),
    });
    return this.finish(node, result, signal);
  }

  private finish(node: RoutingNode, result: FallbackResult, signal: AbortSignal): RouterReply {
    if (result.kind === 'reask') return this.say(result.line);
    const { resolution } = result;
    if (resolution.kind === 'agent') {
      signal.throwIfAborted();
      this.ports.handoff.commit(resolution.handoffId);
      this.pending = undefined;
    }
    this.outcomeValue = { ...resolution, path: [...this.state.path], node: node.id };
    this.phaseValue = resolution.kind === 'agent' ? 'announcing' : 'ended';
    recordFinish(this.recorder, {
      call: this.ports.host.call,
      outcome: this.outcomeValue,
      context: this.state.context,
      turns: this.state.turns,
      startedAt: this.state.startedAt!,
      now: this.ports.host.now(),
      timezone: this.ports.timezone ?? 'UTC',
    });
    return this.say(finishLine(resolution, this.snapshot, this.state.context.language));
  }

  private say(text: string): RouterReply {
    remember(this.state, { role: 'router', text });
    return this.reply(text);
  }

  private reply(say: string): RouterReply {
    return { say, phase: this.phaseValue };
  }
}
