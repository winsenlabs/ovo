import type { RouteContext, RoutingNode, RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import type { TranscriptLine } from './engines/index.ts';

/** Where a node's fallback chain has got to: the step it is on and the re-asks that step has used. */
export interface FallbackCursor {
  index: number;
  reasks: number;
}

/** Everything the router knows about one call. Mutated only by the router core. */
export interface RouterState {
  /** The node whose question the caller is answering. */
  node: string;
  /** Every node entered, root first. */
  path: string[];
  context: RouteContext;
  /** Router turns: caller (speech or keypad) and idle turns. The opening is turn 0. */
  turns: number;
  /** Idle turns since the caller last spoke. */
  idles: number;
  /** When routing started (epoch ms), set by the first turn. */
  startedAt?: number;
  transcript: TranscriptLine[];
  cursors: Map<string, FallbackCursor>;
}

const TRANSCRIPT_MAX = 40;

export function initialState(snapshot: RoutingReleaseSnapshot): RouterState {
  return {
    node: snapshot.root,
    path: [snapshot.root],
    context: { values: {} },
    turns: 0,
    idles: 0,
    transcript: [],
    cursors: new Map(),
  };
}

export function remember(state: RouterState, line: TranscriptLine): void {
  if (!line.text) return;
  state.transcript.push(line);
  if (state.transcript.length > TRANSCRIPT_MAX) state.transcript.shift();
}

export function cursorOf(state: RouterState, node: string): FallbackCursor {
  let cursor = state.cursors.get(node);
  if (!cursor) state.cursors.set(node, (cursor = { index: 0, reasks: 0 }));
  return cursor;
}

export function nodeMap(snapshot: RoutingReleaseSnapshot): ReadonlyMap<string, RoutingNode> {
  return new Map(snapshot.nodes.map((node) => [node.id, node]));
}

/** Which routing limit a new turn is past, if any: the turn count first, then the elapsed time. */
export function limitReason(
  state: RouterState,
  limits: RoutingReleaseSnapshot['limits'],
  now: number,
): 'max_turns' | 'max_route_seconds' | undefined {
  if (state.turns > limits.maxTurns) return 'max_turns';
  if (now - (state.startedAt ?? now) > limits.maxRouteSeconds * 1000) return 'max_route_seconds';
  return undefined;
}
