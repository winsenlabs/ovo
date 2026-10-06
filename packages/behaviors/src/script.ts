import type {
  AgentConfig,
  Behavior,
  BehaviorEvent,
  DecisionPort,
  ScriptGraph,
  SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentConfig as AgentConfigSchema, normalizeForMatch } from '@winsendotai/ovo-contracts';
import { renderAnnouncementTemplate, validateTemplatePaths } from './announcement.ts';
import { callDecision, type DecisionClock } from './flow-decide.ts';
import { scriptDecisionRequest, scriptDecisionTarget } from './flow-script.ts';

export * from './flow-script.ts';

/**
 * A script advances on playback completion, never on generated text alone.
 *
 * Scripts mode versus agent mode (AGT-14): a script (announcement or FAQ mode) is a fixed graph the
 * author wrote, and it only ever moves along a transition the author wrote. With a decision policy
 * enabled and a decision plugin selected, a reply that matches no transition exactly is classified
 * among the current node's text transitions (see `flow-script.ts`); a clear answer takes that
 * transition, anything else falls through as before. Agent mode is where a conversation is routed
 * by an authored flow or composed by the LLM.
 */
export class ScriptBehavior implements Behavior {
  private current: string;
  private pending?: { node: string; text: string; epoch: number };
  private epoch?: number;
  private started = false;
  private visits = 0;
  private generation = 0;
  private faqConfirmation = false;
  private deciding?: AbortController;
  private readonly graph: ScriptGraph;

  constructor(
    private readonly config: AgentConfig,
    private readonly faq?: Behavior,
    private readonly decision?: DecisionPort,
    private readonly clock?: DecisionClock,
  ) {
    this.config = AgentConfigSchema.parse(config);
    if (!this.config.script) throw new Error('Script graph is required');
    this.graph = structuredClone(this.config.script);
    this.current = this.graph.start;
    for (const node of this.graph.nodes) validateTemplatePaths(node.prompt, config.variables);
  }

  async respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    this.pending = undefined;
    const generation = ++this.generation;
    const node = this.graph.nodes.find((node) => node.id === this.current)!;
    if (!this.started) return this.prepare(node.id, variables);
    if (node.terminal) return '';
    if (this.faqConfirmation) return this.detour(input, variables, node.id, generation);
    if (this.visits >= this.graph.maxVisits) return this.config.clarification;
    const event = variables.inputEvent === 'dtmf' ? 'dtmf' : 'text';
    const normalized = normalizeForMatch(input);
    const transition = node.transitions.find(
      (transition) =>
        transition.event === event &&
        transition.matches.some((match) => normalizeForMatch(match) === normalized),
    );
    if (transition) return this.prepare(transition.to, variables);
    // Only a script with a decision policy and plugin waits on anything here; without one the
    // reply goes straight to the detour or the clarification, exactly as before.
    if (event === 'text' && this.config.decision?.enabled && this.decision) {
      const decided = await this.decide(input, node, variables);
      if (generation !== this.generation)
        throw new DOMException('Stale script response', 'AbortError');
      if (decided) return this.prepare(decided, variables);
    }
    if (event === 'dtmf' || !this.faq) return this.config.clarification;
    return this.detour(input, variables, node.id, generation);
  }

  private async detour(
    input: string,
    variables: Record<string, unknown>,
    node: string,
    generation: number,
  ): Promise<string> {
    const answer = await this.faq!.respond(input, variables);
    if (generation !== this.generation)
      throw new DOMException('Stale script response', 'AbortError');
    this.faqConfirmation = this.faq?.speechKind?.(answer) === 'confirmation';
    if (this.faqConfirmation) return answer;
    // An FAQ detour never changes the script state. Repeat its current prompt so
    // the caller has an explicit, deterministic resume point.
    return `${answer} ${this.render(node, variables)}`;
  }

  /** The node a clear decision answer leads to, or undefined to keep the script's own fallback. */
  private async decide(
    input: string,
    node: ScriptGraph['nodes'][number],
    variables: Record<string, unknown>,
  ): Promise<string | undefined> {
    const policy = this.config.decision!;
    if (!input.trim()) return undefined;
    const asked = scriptDecisionRequest(node, {
      caller_reply: input,
      agent_last_said: this.render(node.id, variables),
    });
    if (!asked) return undefined;
    const controller = new AbortController();
    this.deciding = controller;
    try {
      const call = await callDecision(this.decision, asked.request, {
        timeoutMs: policy.timeoutMs,
        signal: controller.signal,
        ...(this.clock ? { clock: this.clock } : {}),
        trace: { flow: { node: node.id, listen: node.id } },
      });
      return call.ok ? scriptDecisionTarget(asked, call.response) : undefined;
    } finally {
      if (this.deciding === controller) this.deciding = undefined;
    }
  }

  onPlayback(receipt: SpeechReceipt): void | Promise<void> {
    const forwarded = this.faq?.onPlayback?.(receipt);
    if (!this.pending || receipt.text !== this.pending.text || receipt.epoch !== this.pending.epoch)
      return forwarded;
    if (receipt.state === 'completed') {
      this.current = this.pending.node;
      this.started = true;
      this.visits++;
    }
    this.pending = undefined;
    return forwarded;
  }

  cancel(): void {
    this.generation++;
    this.deciding?.abort(new DOMException('script turn cancelled', 'AbortError'));
    this.pending = undefined;
    this.faq?.cancel?.();
  }

  get state(): string {
    return this.current;
  }

  isComplete(): boolean {
    return (
      this.started && this.graph.nodes.some((node) => node.id === this.current && node.terminal)
    );
  }

  beginTurn(epoch: number): void {
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      (this.epoch !== undefined && epoch <= this.epoch)
    )
      throw new Error('Script turns require increasing playback epochs');
    this.cancel();
    this.epoch = epoch;
    this.faq?.beginTurn?.(epoch);
  }

  speechKind(text: string) {
    return this.faq?.speechKind?.(text);
  }

  subscribe(listener: (event: BehaviorEvent) => void): () => void {
    return this.faq?.subscribe?.(listener) ?? (() => undefined);
  }

  private prepare(node: string, variables: Record<string, unknown>): string {
    const text = this.render(node, variables);
    if (this.epoch === undefined) throw new Error('Script requires beginTurn before response');
    this.pending = { node, text, epoch: this.epoch };
    return text;
  }

  private render(id: string, variables: Record<string, unknown>): string {
    return renderAnnouncementTemplate(
      this.graph.nodes.find((node) => node.id === id)!.prompt,
      variables,
      this.config.variables,
      this.config,
    );
  }
}

/** `decision` is the selected decision plugin; a script uses it only when its policy is enabled. */
export function withScript(
  config: AgentConfig,
  behavior: Behavior,
  decision?: DecisionPort,
): Behavior {
  return config.script
    ? new ScriptBehavior(config, config.mode === 'faq' ? behavior : undefined, decision)
    : behavior;
}
