import type { AgentConfig, Behavior, ScriptGraph, SpeechReceipt } from '@winsendotai/ovo-contracts';
import { AgentConfig as AgentConfigSchema } from '@winsendotai/ovo-contracts';
import { renderAnnouncementTemplate, validateTemplatePaths } from './announcement.ts';

/** A script advances on playback completion, never on generated text alone. */
export class ScriptBehavior implements Behavior {
  private current: string;
  private pending?: { node: string; text: string; epoch: number };
  private epoch?: number;
  private started = false;
  private visits = 0;
  private generation = 0;
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
    if (this.visits >= this.graph.maxVisits) return this.config.clarification;
    const event = variables.inputEvent === 'dtmf' ? 'dtmf' : 'text';
    const normalized = input.normalize('NFKC').trim().toLowerCase();
    const transition = node.transitions.find(
      (transition) =>
        transition.event === event &&
        transition.matches.some(
          (match) => match.normalize('NFKC').trim().toLowerCase() === normalized,
        ),
    );
    if (transition) return this.prepare(transition.to, variables);
    if (event === 'dtmf' || !this.faq) return this.config.clarification;
    const answer = await this.faq.respond(input, variables);
    if (generation !== this.generation)
      throw new DOMException('Stale script response', 'AbortError');
    // An FAQ detour never changes the script state. Repeat its current prompt so
    // the caller has an explicit, deterministic resume point.
    return `${answer} ${this.render(node.id, variables)}`;
  }

  onPlayback(receipt: SpeechReceipt): void {
    if (!this.pending || receipt.text !== this.pending.text || receipt.epoch !== this.pending.epoch)
      return;
    if (receipt.state === 'completed') {
      this.current = this.pending.node;
      this.started = true;
      this.visits++;
    }
    this.pending = undefined;
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
