import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Inference,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { PlaybackConversation } from './history.ts';
import { StreamingTextSegmenter } from './text-segmenter.ts';

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
  private readonly conversation = new PlaybackConversation();

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
    const segments: string[] = [];
    for await (const segment of this.runResponse(input, false)) segments.push(segment);
    return segments.join(' ');
  }

  respondStream(input: string): AsyncIterable<string> {
    return this.runResponse(input, true);
  }

  private async *runResponse(input: string, streaming: boolean): AsyncIterable<string> {
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const request = {
      input,
      history: this.conversation.user(input),
      context: this.assembledContext,
      uncertainty: this.config.uncertainty,
      tools: [],
      results: [],
      signal: controller.signal,
    };
    try {
      if (streaming && this.inference.stream) {
        const segmenter = new StreamingTextSegmenter();
        let emitted = false;
        for await (const event of this.inference.stream(request)) {
          controller.signal.throwIfAborted();
          if (turn !== this.turn) throw new DOMException('stale context turn', 'AbortError');
          if (event.kind === 'tool') throw new Error('Context inference returned a tool call');
          if (event.kind !== 'text-delta') continue;
          for (const segment of segmenter.push(event.delta)) {
            emitted = true;
            yield this.conversation.generated(segment);
          }
        }
        for (const segment of segmenter.finish()) {
          emitted = true;
          yield this.conversation.generated(segment);
        }
        if (!emitted) yield this.conversation.generated(this.config.uncertainty);
        return;
      }
      const reply = await this.inference.generate(request);
      controller.signal.throwIfAborted();
      const text =
        turn === this.turn && reply.kind === 'text' && reply.text.trim()
          ? reply.text.trim()
          : this.config.uncertainty;
      yield this.conversation.generated(text);
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(reason = 'context turn cancelled'): void {
    this.turn += 1;
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
  }

  beginTurn(epoch: number): void {
    this.conversation.beginTurn(epoch);
  }
  onPlayback(receipt: SpeechReceipt): void {
    this.conversation.played(receipt);
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
