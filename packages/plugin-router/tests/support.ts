import { RoutingNode, type RoutingEngine } from '@winsendotai/ovo-contracts';
import type { EngineInput, RouteTurn, TranscriptLine } from '../src/engines/index.ts';

/** A node with `sales` and `support` end branches and the given engines. */
export function engineNode(engines: unknown[], keys = ['sales', 'support']): RoutingNode {
  return RoutingNode.parse({
    id: 'intent',
    engines,
    branches: keys.map((key) => ({
      key,
      description: `The caller wants ${key}`,
      target: { kind: 'end', line: { en: 'Bye.' } },
    })),
    fallback: [{ kind: 'end', line: { en: 'Bye.' } }],
  });
}

export function engineOf<K extends RoutingEngine['kind']>(
  node: RoutingNode,
  kind: K,
): Extract<RoutingEngine, { kind: K }> {
  return node.engines.find((engine) => engine.kind === kind) as Extract<RoutingEngine, { kind: K }>;
}

export function engineInput(
  node: RoutingNode,
  turn: RouteTurn | undefined,
  over: { transcript?: TranscriptLine[]; signal?: AbortSignal; languages?: string[] } = {},
): EngineInput {
  return {
    node,
    ...(turn ? { turn } : {}),
    context: { values: {} },
    languages: over.languages ?? ['en', 'hi'],
    transcript: over.transcript ?? [],
    signal: over.signal ?? new AbortController().signal,
  };
}

/** A promise that settles only when `signal` aborts (a port that waits for its deadline). */
export function untilAborted<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
}

/** A promise that never settles (a port that ignores its signal). */
export const forever = <T>() => new Promise<T>(() => {});
