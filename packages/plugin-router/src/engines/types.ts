import type {
  RouteContext,
  RoutingEngine,
  RoutingEngineKind,
  RoutingNode,
} from '@winsendotai/ovo-contracts';

/** One caller turn as the engines read it. A DTMF turn has `digits`; a speech turn has `text`. */
export interface RouteTurn {
  text?: string;
  digits?: string;
}

/** What the router and the caller said so far, oldest first (no notes, no ids). */
export interface TranscriptLine {
  role: 'router' | 'caller';
  text: string;
}

export interface EngineInput {
  node: RoutingNode;
  /** Absent on the opening, when only engines that need no caller turn run. */
  turn?: RouteTurn;
  context: Readonly<RouteContext>;
  /** The call's allowed languages (the LLM's language enum). */
  languages: readonly string[];
  transcript: readonly TranscriptLine[];
  signal: AbortSignal;
}

export type EngineOutcome =
  'matched' | 'no_match' | 'low_confidence' | 'timeout' | 'error' | 'disabled';

/**
 * One engine's verdict on one node. `matched` names a branch of the node at or above the engine's
 * threshold; anything else lets the next engine try. `slots` and `language` are context values the
 * engine read from the turn; `clarify` is a generated re-ask question, only from an LLM engine
 * with `generatedClarify`.
 */
export interface EngineResult {
  outcome: EngineOutcome;
  branch?: string;
  confidence?: number;
  slots?: Record<string, string>;
  language?: string;
  clarify?: string;
  modelId?: string;
  reason?: string;
}

export type EngineRunner<K extends RoutingEngineKind = RoutingEngineKind> = (
  engine: Extract<RoutingEngine, { kind: K }>,
  input: EngineInput,
) => Promise<EngineResult>;

/** One runner per engine kind. The router core receives them, so a simulator can script them. */
export type EngineRunners = { [K in RoutingEngineKind]: EngineRunner<K> };

export const branchKeys = (node: RoutingNode): string[] =>
  node.branches.map((branch) => branch.key);

/** The caller's words for an engine that reads text: the speech, else the keypad digits. */
export const turnText = (turn: RouteTurn | undefined): string =>
  (turn?.text ?? turn?.digits ?? '').trim();

export class EngineTimeout extends Error {
  constructor() {
    super('routing engine timed out');
  }
}

/**
 * Runs `work` with a signal that aborts after `timeoutMs` or with `parent`, and rejects with
 * `EngineTimeout` at the deadline even when the port ignores its signal. A `parent` abort (the turn
 * was cancelled) rejects with the parent's reason, which the router passes up rather than recording.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach = () => {};
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new EngineTimeout());
      reject(new EngineTimeout());
    }, timeoutMs);
    const onParent = () => {
      controller.abort(parent.reason);
      reject(parent.reason);
    };
    parent.addEventListener('abort', onParent, { once: true });
    detach = () => parent.removeEventListener('abort', onParent);
  });
  try {
    return await Promise.race([work(controller.signal), stop]);
  } finally {
    clearTimeout(timer);
    detach();
  }
}
