import {
  ROUTING_LIMITS,
  type HoldPolicy,
  type RoutingNode,
  type RoutingPointDraft,
  type RoutingTarget,
} from '@winsendotai/ovo-contracts';

/** Every pure tree edit answers with the new draft or the reason it refused; nothing throws. */
export type EditResult = { draft: RoutingPointDraft } | { error: string };

const KEY = /^[a-z][a-z0-9_-]{0,79}$/;
export const isRoutingKey = (value: string) => KEY.test(value);
const KEY_HELP = 'Use lowercase letters, digits, - or _, starting with a letter (80 at most).';

const nodeIndex = (draft: RoutingPointDraft, id: string) => draft.nodes.findIndex((n) => n.id === id);

/** Branches (and transfer targets) that lead to a node, for the "who points here" message. */
export function referencesTo(
  draft: RoutingPointDraft,
  id: string,
): { node: string; branch: string }[] {
  const found: { node: string; branch: string }[] = [];
  for (const node of draft.nodes)
    for (const branch of node.branches)
      if (branch.next === id) found.push({ node: node.id, branch: branch.key });
  return found;
}

const transferTargetsTo = (draft: RoutingPointDraft, id: string) =>
  (draft.transfer?.targets ?? []).filter((t) => t.destination.kind === 'node' && t.destination.node === id);

/** Rename a node and every reference to it: the root, branch `next`s and transfer re-route targets. */
export function renameNode(draft: RoutingPointDraft, from: string, to: string): EditResult {
  if (from === to) return { draft };
  if (!isRoutingKey(to)) return { error: KEY_HELP };
  if (nodeIndex(draft, from) < 0) return { error: `No node ${from}.` };
  if (nodeIndex(draft, to) >= 0) return { error: `A node called ${to} already exists.` };
  return {
    draft: {
      ...draft,
      root: draft.root === from ? to : draft.root,
      nodes: draft.nodes.map((node) => ({
        ...node,
        id: node.id === from ? to : node.id,
        branches: node.branches.map((b) => (b.next === from ? { ...b, next: to } : b)),
      })),
      transfer: draft.transfer && {
        ...draft.transfer,
        targets: draft.transfer.targets.map((t) =>
          t.destination.kind === 'node' && t.destination.node === from
            ? { ...t, destination: { ...t.destination, node: to } }
            : t,
        ),
      },
    },
  };
}

/** Delete a node. The root and a node something still leads to are refused, with who leads there. */
export function deleteNode(draft: RoutingPointDraft, id: string): EditResult {
  if (nodeIndex(draft, id) < 0) return { error: `No node ${id}.` };
  if (draft.root === id) return { error: 'The first question cannot be deleted. Make another node the root first.' };
  const leading = referencesTo(draft, id);
  const transfers = transferTargetsTo(draft, id);
  if (leading.length || transfers.length) {
    const who = [
      ...leading.map((r) => `${r.node} > ${r.branch}`),
      ...transfers.map((t) => `transfer target ${t.key}`),
    ];
    return { error: `Still used by ${who.join(', ')}. Point those somewhere else first.` };
  }
  return { draft: { ...draft, nodes: draft.nodes.filter((n) => n.id !== id) } };
}

export function addNode(draft: RoutingPointDraft, node: RoutingNode): EditResult {
  if (!isRoutingKey(node.id)) return { error: KEY_HELP };
  if (nodeIndex(draft, node.id) >= 0) return { error: `A node called ${node.id} already exists.` };
  if (draft.nodes.length >= ROUTING_LIMITS.nodes)
    return { error: `At most ${ROUTING_LIMITS.nodes} nodes.` };
  return { draft: { ...draft, nodes: [...draft.nodes, node] } };
}

/** Rename a branch key and the rules of the same node that name it. */
export function renameBranch(
  draft: RoutingPointDraft,
  nodeId: string,
  from: string,
  to: string,
): EditResult {
  const node = draft.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: `No node ${nodeId}.` };
  if (from === to) return { draft };
  if (!isRoutingKey(to)) return { error: KEY_HELP };
  if (node.branches.some((b) => b.key === to)) return { error: `Branch ${to} already exists here.` };
  const renamed: RoutingNode = {
    ...node,
    branches: node.branches.map((b) => (b.key === from ? { ...b, key: to } : b)),
    engines: node.engines.map((engine) =>
      engine.kind === 'rules'
        ? { ...engine, rules: engine.rules.map((r) => (r.branch === from ? { ...r, branch: to } : r)) }
        : engine,
    ),
  };
  return { draft: { ...draft, nodes: draft.nodes.map((n) => (n.id === nodeId ? renamed : n)) } };
}

/** Move an item of a list one place (`delta` -1 up, +1 down); out of range leaves the list as it was. */
export function moveStep<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removeStep<T>(list: readonly T[], index: number, keepAtLeast = 0): T[] {
  return list.length <= keepAtLeast ? [...list] : list.filter((_, i) => i !== index);
}

/** Replace one node by id, keeping its place. */
export function replaceNode(draft: RoutingPointDraft, id: string, node: RoutingNode): RoutingPointDraft {
  return { ...draft, nodes: draft.nodes.map((n) => (n.id === id ? node : n)) };
}

/** Rename a queue binding's key and every `human` step, target and hold that names it. */
export function renameQueueKey(draft: RoutingPointDraft, from: string, to: string): EditResult {
  if (from === to) return { draft };
  if (!isRoutingKey(to)) return { error: KEY_HELP };
  const bindings = draft.humanQueues ?? [];
  if (!bindings.some((b) => b.key === from)) return { error: `No queue bound as ${from}.` };
  if (bindings.some((b) => b.key === to)) return { error: `A queue is already bound as ${to}.` };
  const holdOf = <T extends { onTimeout: HoldPolicy['onTimeout'] }>(hold: T | undefined) =>
    hold && { ...hold, onTimeout: hold.onTimeout.map((s) => (s.kind === 'human' && s.queueId === from ? { ...s, queueId: to } : s)) };
  const target = (t: RoutingTarget | undefined): RoutingTarget | undefined =>
    t?.kind === 'human' && t.queueId === from ? { ...t, queueId: to } : t;
  return {
    draft: {
      ...draft,
      humanQueues: bindings.map((b) => (b.key === from ? { ...b, key: to } : b)),
      nodes: draft.nodes.map((node) => ({
        ...node,
        branches: node.branches.map((b) => (b.target ? { ...b, target: target(b.target) } : b)) as RoutingNode['branches'],
        fallback: node.fallback.map((s) =>
          s.kind === 'human' && s.queueId === from
            ? { ...s, queueId: to }
            : s.kind === 'default' && s.target
              ? { ...s, target: target(s.target) }
              : s,
        ),
      })),
      transfer: draft.transfer && {
        ...draft.transfer,
        hold: holdOf(draft.transfer.hold),
        targets: draft.transfer.targets.map((t) => ({
          ...t,
          hold: holdOf(t.hold),
          destination: t.destination.kind === 'human' && t.destination.queueId === from ? { ...t.destination, queueId: to } : t.destination,
        })),
      },
    },
  };
}
