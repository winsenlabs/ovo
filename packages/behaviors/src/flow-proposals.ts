import {
  routeFlowIntent,
  type CompiledFlow,
  type FlowIntent,
  type FlowPosition,
  type FlowTransition,
} from '@winsendotai/ovo-contracts';
import type { FlowPlayout } from './flow-playout.ts';
import type { FlowLine, FlowStep } from './flow-types.ts';

/** The call's state a proposal is made in. */
export interface FlowView {
  position: FlowPosition;
  /** The entered node's lines, which a repeat replays until the agent has said anything. */
  last: readonly FlowLine[];
  playout: FlowPlayout;
}

/**
 * The steps a flow can propose for a turn: enter a node, say something again (repeat, hold, or a
 * node whose mandatory lines went unheard), or fall back. Proposing moves nothing; `FlowSession`
 * commits the step a turn actually speaks.
 */
export class FlowProposals {
  constructor(
    private readonly compiled: CompiledFlow,
    private readonly view: () => FlowView,
    private readonly now: () => string,
  ) {}

  /**
   * The question the caller is being asked now: the node's last line while the call listens with
   * the node's own listen set, otherwise (the LLM resumed elsewhere) the last thing the agent said.
   */
  question(): FlowLine | undefined {
    const { position, playout } = this.view();
    const node = position.node ? this.compiled.nodes.get(position.node) : undefined;
    const own = node?.say.at(-1);
    if (node && own !== undefined && node.listen === position.listen) return this.line(own);
    const text = playout.lastSaid.at(-1);
    return text === undefined ? undefined : spoken(text);
  }

  /**
   * P5: the caller barged in before hearing the node's mandatory lines, so whatever they said
   * answers a question they never heard. The node is said again from the first unheard one, unless
   * they asked for something that leaves the state outright (a global intent such as stop calling).
   */
  unheardReplay(step: FlowStep): FlowStep | undefined {
    const global = this.compiled.flow.globalIntents.some(
      (intent) => intent.key === step.transition.intent,
    );
    if (step.kind === 'enter' && global) return undefined;
    const { position, playout } = this.view();
    const node = position.node ? this.compiled.nodes.get(position.node) : undefined;
    const again = node && playout.replay(node);
    if (!again) return undefined;
    const { tier, intent, confidence, modelId } = step.transition;
    return {
      kind: 'repeat',
      lines: again.map((id) => this.line(id)),
      transition: this.transition(
        { ...position },
        {
          tier,
          ...(intent === undefined ? {} : { intent }),
          ...(confidence === undefined ? {} : { confidence }),
          ...(modelId === undefined ? {} : { modelId }),
          reason: 'unheard',
        },
      ),
    };
  }

  follow(
    intent: FlowIntent,
    slots: Readonly<Record<string, string>>,
    trace: Partial<FlowTransition> & Pick<FlowTransition, 'tier'>,
  ): FlowStep {
    const target = routeFlowIntent(intent, slots);
    if (target.kind === 'node') return this.enter(target.node, trace);
    const flow = this.compiled.flow;
    const prefix = target.kind === 'hold' ? flow.holdPrefix : flow.repeatPrefix;
    const question = target.kind === 'hold' ? this.question() : undefined;
    const { position, playout, last } = this.view();
    const said = playout.lastSaid;
    const again =
      target.kind === 'hold' && question ? [question] : said.length ? said.map(spoken) : last;
    return {
      kind: 'repeat',
      lines: [...(prefix ? [this.line(prefix)] : []), ...again],
      transition: this.transition({ ...position }, trace),
    };
  }

  enter(nodeId: string, trace: Partial<FlowTransition> & Pick<FlowTransition, 'tier'>): FlowStep {
    const node = this.compiled.nodes.get(nodeId)!;
    return {
      kind: 'enter',
      node: node.id,
      lines: node.say.map((id) => this.line(id)),
      end: node.end,
      transition: this.transition(
        { node: node.id, ...(node.listen ? { listen: node.listen } : {}) },
        { ...trace, ...(node.disposition ? { disposition: node.disposition } : {}) },
      ),
    };
  }

  /**
   * A reply that fits nothing. After the call's ending node was barged into, a flow without an
   * LLM says its goodbye again rather than leaving the caller in a state with nothing to listen for.
   */
  fallback(
    trace: Partial<FlowTransition>,
    unavailable?: { reason: 'timeout' | 'error' | 'invalid'; message: string },
  ): FlowStep {
    const flow = this.compiled.flow;
    const { position } = this.view();
    if (trace.reason === 'ended' && flow.fallback === 'clarify' && position.node)
      return this.enter(position.node, { tier: 'fallback', reason: 'ended' });
    return {
      kind: 'fallback',
      action: flow.fallback,
      ...(flow.fallback === 'clarify' && flow.clarify ? { line: this.line(flow.clarify) } : {}),
      transition: this.transition({ ...position }, { ...trace, tier: 'fallback' }),
      ...(unavailable ? { unavailable } : {}),
    };
  }

  transition(
    to: FlowPosition,
    trace: Partial<FlowTransition> & Pick<FlowTransition, 'tier'>,
  ): FlowTransition {
    return { at: this.now(), from: { ...this.view().position }, to, ...trace };
  }

  line(id: string): FlowLine {
    return { id, template: this.compiled.flow.lines[id]! };
  }
}

/** A line the agent already said, replayed as it was. */
const spoken = (text: string): FlowLine => ({ id: 'spoken', template: text, rendered: true });
