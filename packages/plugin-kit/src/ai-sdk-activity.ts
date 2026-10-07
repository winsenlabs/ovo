import type { TextStreamPart, ToolSet } from 'ai';

/**
 * What a voice engine may say while a provider-run tool works, so the caller does not sit through
 * the search in silence (N3): `line` when the tool starts, `stillLine` once `stillAfterMs` pass
 * after that with no reply text yet. Either may be left out.
 */
export interface ActivityAnnouncement {
  line?: string;
  stillLine?: string;
  stillAfterMs: number;
}

/**
 * A tool the provider runs inside an inference step (OpenAI's web search), seen as it happens:
 * `started` when the provider streams the call, before it runs, and `finished` when its result
 * arrives or the request ends without one (`cancelled`). Never part of the reply itself.
 */
export type InferenceActivity = {
  /** The tool's name as the model sees it, e.g. `web_search`. */
  tool: string;
  /** The provider's id for the call; pairs a start with its finish. */
  id: string;
  /** The inference's clock, in ms. */
  atMs: number;
  /** The request it belongs to: aborted once the turn abandoned it. */
  signal: AbortSignal;
} & (
  | { phase: 'started'; announce?: ActivityAnnouncement }
  | {
      phase: 'finished';
      outcome: 'succeeded' | 'failed' | 'cancelled';
      durationMs: number;
      /** What the call did (`search`, `openPage`, `findInPage`), when reported. */
      action?: string;
      /** How many sources a search returned, when the provider reported them. */
      results?: number;
    }
);

export type InferenceActivityListener = (activity: InferenceActivity) => void;

/** An inference port that reports its provider-run tools as they happen. */
export interface InferenceActivitySource {
  observeActivity(listener: InferenceActivityListener): () => void;
}

/** The port's activity reports, when it has any (an AiSdkInference with provider tools). */
export function inferenceActivity(inference: unknown): InferenceActivitySource | undefined {
  const candidate = inference as Partial<InferenceActivitySource> | null | undefined;
  return typeof candidate?.observeActivity === 'function'
    ? (candidate as InferenceActivitySource)
    : undefined;
}

/** Listeners for one inference port. A listener that throws never reaches the reply. */
export class ActivityListeners implements InferenceActivitySource {
  private readonly listeners = new Set<InferenceActivityListener>();

  observeActivity(listener: InferenceActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(activity: InferenceActivity): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(activity);
      } catch {
        // swallow-ok: an observer (telemetry, a filler line) must never break the reply it watches.
      }
    }
  }
}

type Part = TextStreamPart<ToolSet>;

/**
 * Follows one streamed step's provider-executed calls. The AI SDK reports OpenAI's
 * `response.output_item.added` for a `web_search_call` as `tool-input-start` (then `tool-call`),
 * both `providerExecuted`, before the search runs, and its `output_item.done` as `tool-result`.
 */
export class StepActivity {
  private readonly open = new Map<string, { tool: string; startedAt: number }>();
  private readonly seen = new Set<string>();
  /** Provider-run calls started in this step, finished or not. */
  started = 0;

  constructor(
    private readonly emit: (activity: InferenceActivity) => void,
    private readonly signal: AbortSignal,
    private readonly now: () => number,
    private readonly announce?: ActivityAnnouncement,
  ) {}

  observe(part: Part): void {
    if (part.type === 'tool-input-start' || part.type === 'tool-call') {
      if (!part.providerExecuted) return;
      const id = part.type === 'tool-call' ? part.toolCallId : part.id;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      this.started += 1;
      const atMs = this.now();
      this.open.set(id, { tool: part.toolName, startedAt: atMs });
      this.emit({
        phase: 'started',
        tool: part.toolName,
        id,
        atMs,
        signal: this.signal,
        ...(this.announce ? { announce: this.announce } : {}),
      });
    } else if ((part.type === 'tool-result' || part.type === 'tool-error') && part.providerExecuted)
      this.finish(
        part.toolCallId,
        part.type === 'tool-result' ? 'succeeded' : 'failed',
        part.type === 'tool-result' ? part.output : undefined,
      );
  }

  /** The step ended: a call still open never reported its result. */
  close(): void {
    for (const id of [...this.open.keys()]) this.finish(id, 'cancelled');
  }

  private finish(
    id: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    output?: unknown,
  ): void {
    const call = this.open.get(id);
    if (!call) return;
    this.open.delete(id);
    const atMs = this.now();
    const reported = output as
      { action?: { type?: unknown }; sources?: unknown } | null | undefined;
    const action = reported?.action?.type;
    this.emit({
      phase: 'finished',
      tool: call.tool,
      id,
      atMs,
      signal: this.signal,
      outcome,
      durationMs: Math.max(0, atMs - call.startedAt),
      ...(typeof action === 'string' ? { action } : {}),
      ...(Array.isArray(reported?.sources) ? { results: reported.sources.length } : {}),
    });
  }
}
