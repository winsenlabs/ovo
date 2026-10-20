import type {
  RouteLines,
  RoutingNode,
  RoutingReleaseSnapshot,
  RoutingTarget,
} from '@winsendotai/ovo-contracts';
import type { RouteTurn } from './engines/index.ts';
import { evaluateTurn, type EvaluateEnv } from './evaluate.ts';
import { RouteRecorder } from './events.ts';
import { handoffMode, type HandoffMode } from './begin.ts';
import { RouterDisclosure } from './disclosure.ts';
import {
  fallbackEvent,
  recordTargetFailure,
  releaseDefault,
  runFallback,
  type FallbackResult,
} from './fallback.ts';
import { BUILT_IN_LINES, pickLine } from './lines.ts';
import {
  cursorOf,
  initialState,
  limitReason,
  nodeMap,
  progressOf,
  remember,
  type RouterState,
} from './state.ts';
import { attemptFor, type RouteOutcome } from './targets.ts';
import { completionReasonOf, finishLine, recordFinish } from './finish.ts';
import type { RouterPhase, RouterPorts, RouterReply } from './ports.ts';

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
  private readonly mode?: HandoffMode;
  /** R2 (begin path only): what is left to disclose, said once before the greeting. */
  readonly disclosure?: RouterDisclosure;

  constructor(
    readonly snapshot: RoutingReleaseSnapshot,
    private readonly ports: RouterPorts,
  ) {
    this.recorder = new RouteRecorder(ports.events);
    this.state = initialState(snapshot, ports.entry);
    this.nodes = nodeMap(snapshot);
    this.mode = handoffMode(ports, snapshot);
    const parts = ports.handoff.begin ? ports.disclosure : undefined;
    this.disclosure = RouterDisclosure.of(parts, ports.entry?.disclosed ?? [], this.recorder);
  }

  get phase(): RouterPhase {
    return this.phaseValue;
  }

  get outcome(): RouteOutcome | undefined {
    return this.outcomeValue;
  }

  /** Where the route stands (node, path, context, router turns), as a copy for a simulator to read. */
  get progress(): ReturnType<typeof progressOf> {
    return progressOf(this.state);
  }

  /** `route:<agent|end|callback>:<path joined by '>'>`, at most 200 characters, once decided. */
  completionReason(): string | undefined {
    return this.outcomeValue && completionReasonOf(this.outcomeValue);
  }

  /**
   * The opening turn: instant engines may decide at once; otherwise the greeting, after what is
   * left to disclose. A re-routed router asks its node (no question: the node's fallback) instead.
   */
  opening(signal: AbortSignal): Promise<RouterReply> {
    return this.guard(async () => {
      if (this.phaseValue !== 'routing') return this.reply('');
      this.start();
      const evaluation = await evaluateTurn(this.state, undefined, this.env(signal));
      if (evaluation.kind === 'target')
        return this.route(evaluation.node, evaluation.target, signal);
      const ask = (evaluation.kind === 'ask' || this.ports.entry) && evaluation.node.ask;
      if (this.ports.entry && !ask) return this.fallback(evaluation.node, signal, {});
      const greeting = this.ports.entry ? '' : this.line(this.snapshot.greeting);
      const line = [greeting, ask ? this.line(ask) : ''].filter(Boolean).join(' ');
      return this.say(this.disclosure?.before(line) ?? line);
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
    const reentered = this.ports.entry?.node;
    const env = { snapshot, nodes, recorder, runners: this.ports.runners, now: this.now, signal };
    return reentered ? { ...env, reentered } : env;
  }

  private readonly now = () => this.ports.host.now();

  private line(lines: RouteLines): string {
    return pickLine(lines, this.state.context.language, this.snapshot.language.default);
  }

  private attempt(node: RoutingNode, signal: AbortSignal) {
    const source = { snapshot: this.snapshot, ports: this.ports, state: this.state };
    return attemptFor(
      {
        ...source,
        ...(this.mode ? { mode: this.mode } : {}),
        prepared: (id) => (this.pending = id),
      },
      node,
      signal,
    );
  }

  private chainInput(node: RoutingNode, signal: AbortSignal) {
    const defaultTarget: RoutingTarget = { kind: 'agent', agent: this.snapshot.defaultTarget };
    return {
      node,
      turn: this.state.turns,
      recorder: this.recorder,
      defaultTarget,
      finalLine: this.line(BUILT_IN_LINES.end),
      attempt: this.attempt(node, signal),
    };
  }

  /** The turn and time limits (§7.5 step 2): past either, the release default target. */
  private async limit(signal: AbortSignal): Promise<RouterReply | undefined> {
    const reason = limitReason(this.state, this.snapshot.limits, this.ports.host.now());
    if (!reason) return undefined;
    const node = this.nodes.get(this.state.node)!;
    const input = this.chainInput(node, signal);
    fallbackEvent(input, 'limit', 'taken', 1, reason);
    return this.finish(node, await releaseDefault(input), signal);
  }

  private async route(node: RoutingNode, target: RoutingTarget, signal: AbortSignal) {
    const attempt = await this.attempt(node, signal)(target);
    if (attempt.ok)
      return this.finish(node, { kind: 'resolved', resolution: attempt.resolution }, signal);
    const cursor = cursorOf(this.state, node.id);
    recordTargetFailure({ ...this.chainInput(node, signal), cursor }, attempt.reason);
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
    const handsOn = 'handoffId' in resolution;
    if (handsOn) {
      signal.throwIfAborted();
      this.ports.handoff.commit(resolution.handoffId);
      this.pending = undefined;
    }
    this.outcomeValue = { ...resolution, path: [...this.state.path], node: node.id };
    this.phaseValue = handsOn ? 'announcing' : 'ended';
    recordFinish(this.recorder, this.ports, this.state, this.outcomeValue);
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
