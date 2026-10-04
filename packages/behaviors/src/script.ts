import type {
  AgentConfig,
  Behavior,
  BehaviorEvent,
  ScriptGraph,
  SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentConfig as AgentConfigSchema, normalizeForMatch } from '@winsendotai/ovo-contracts';
import { renderAnnouncementTemplate, validateTemplatePaths } from './announcement.ts';

/** A script advances on playback completion, never on generated text alone. */
export class ScriptBehavior implements Behavior {
  private current: string;
  private pending?: { node: string; text: string; epoch: number };
  private epoch?: number;
  private started = false;
  private visits = 0;
  private generation = 0;
  private faqConfirmation = false;
  private readonly graph: ScriptGraph;

  constructor(
    private readonly config: AgentConfig,
    private readonly faq?: Behavior,
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

export function withScript(config: AgentConfig, behavior: Behavior): Behavior {
  return config.script
    ? new ScriptBehavior(config, config.mode === 'faq' ? behavior : undefined)
    : behavior;
}
