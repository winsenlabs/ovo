import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Inference,
} from '@winsendotai/ovo-contracts';

export class ContextBudgetExceededError extends Error {
  constructor(
    readonly actual: number,
    readonly budget: number,
  ) {
    super(
      `Supplied context contains ${actual} Unicode code points, exceeding the configured budget of ${budget}`,
    );
    this.name = 'ContextBudgetExceededError';
  }
}

export class ContextBehavior implements Behavior {
  readonly config: AgentConfig;
  readonly assembledContext: string;
  private active?: AbortController;
  private turn = 0;

  constructor(
    config: AgentConfig,
    private readonly inference: Inference,
  ) {
    this.config = AgentConfigSchema.parse(config);
    if (this.config.mode !== 'context') {
      throw new TypeError(`Context behavior requires context mode, received ${this.config.mode}`);
    }
    this.assembledContext = assembleBoundedContext(this.config.context, this.config.contextBudget);
  }

  async respond(input: string): Promise<string> {
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    try {
      const reply = await this.inference.generate({
        input,
        context: this.assembledContext,
        uncertainty: this.config.uncertainty,
        tools: [],
        results: [],
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (turn !== this.turn || reply.kind !== 'text' || !reply.text.trim())
        return this.config.uncertainty;
      return reply.text.trim();
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(reason = 'context turn cancelled'): void {
    this.turn += 1;
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
  }
}

export function createContextBehavior(config: AgentConfig, inference: Inference): ContextBehavior {
  return new ContextBehavior(config, inference);
}

/**
 * The first implementation treats contextBudget as a Unicode-code-point budget.
 * It fails publication/construction rather than silently dropping critical facts.
 */
export function assembleBoundedContext(context: string, budget: number): string {
  const actual = [...context].length;
  if (actual > budget) throw new ContextBudgetExceededError(actual, budget);
  return context;
}
