import type { AgentFlow, FlowListen, FlowNode } from './agent-flow.ts';
import { routeTargets } from './agent-flow-queries.ts';

/** Nodes reachable from `from` (the start), entering only nodes `enter` accepts. */
export function reachable(
  flow: AgentFlow,
  nodes: ReadonlyMap<string, FlowNode>,
  listens: ReadonlyMap<string, FlowListen>,
  enter: (node: FlowNode) => boolean,
  from = flow.start,
): Set<string> {
  const reached = new Set<string>();
  const queue = [from];
  let globalsVisited = false;
  while (queue.length) {
    const id = queue.shift()!;
    const node = nodes.get(id);
    if (!node || reached.has(id)) continue;
    reached.add(id);
    if (!enter(node) || node.listen === undefined) continue;
    const listen = listens.get(node.listen);
    for (const intent of listen?.intents ?? []) queue.push(...routeTargets(intent.next));
    if (!globalsVisited) {
      globalsVisited = true;
      for (const intent of flow.globalIntents) queue.push(...routeTargets(intent.next));
    }
  }
  return reached;
}

/**
 * The listen sets the LLM fallback may resume at on either side of identity confirmation: before
 * it, those reachable without entering an identity-confirming node; after it, those reachable from
 * one. A flow that confirms no identity has every listen set on both sides.
 */
export function verificationListens(
  flow: AgentFlow,
  nodes: ReadonlyMap<string, FlowNode>,
  listens: ReadonlyMap<string, FlowListen>,
): { before: Set<string>; after: Set<string> } {
  if (!flow.nodes.some((node) => node.verified))
    return { before: new Set(listens.keys()), after: new Set(listens.keys()) };
  const listenOf = (id: string) => nodes.get(id)?.listen;
  const before = [...reachable(flow, nodes, listens, (node) => !node.verified)].filter(
    (id) => !nodes.get(id)!.verified,
  );
  const after = flow.nodes
    .filter((node) => node.verified)
    .flatMap((node) => [...reachable(flow, nodes, listens, () => true, node.id)]);
  const listenSet = (ids: string[]) =>
    new Set(ids.flatMap((id) => (listenOf(id) === undefined ? [] : [listenOf(id)!])));
  return { before: listenSet(before), after: listenSet(after) };
}
