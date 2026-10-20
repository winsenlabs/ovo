import { ROUTING_LIMITS, RoutingKey } from './ids.ts';
import { RoutingNode } from './tree.ts';
import type { RoutingPointDraft } from './point.ts';
import type { RoutingPath } from './tree.ts';

/**
 * Pure tree edits the designer uses. Each returns the edited copy (the input is never changed) or
 * why it refused; none validates the whole draft, which `routingDraftIssues` does.
 */
export type RoutingEditErrorCode =
  | 'invalid_id'
  | 'node_unknown'
  | 'node_exists'
  | 'node_limit'
  | 'root_delete'
  | 'node_referenced'
  | 'branch_unknown'
  | 'branch_exists'
  | 'step_unknown'
  | 'last_step';
export interface RoutingEditError {
  code: RoutingEditErrorCode;
  message: string;
  /** `node_referenced`: where the node is still named. */
  referrers?: RoutingPath[];
}
export type RoutingEditResult = { draft: RoutingPointDraft } | { error: RoutingEditError };

export type RoutingStepList = 'engines' | 'fallback' | 'branches';

const fail = (code: RoutingEditErrorCode, message: string, referrers?: RoutingPath[]) => ({
  error: { code, message, ...(referrers ? { referrers } : {}) },
});

/** Where a draft names a node: `root`, branch `next`, and `node` transfer destinations. */
export function routingNodeReferrers(draft: RoutingPointDraft, id: string): RoutingPath[] {
  const found: RoutingPath[] = [];
  if (draft.root === id) found.push(['root']);
  draft.nodes.forEach((node, n) =>
    node.branches.forEach((branch, b) => {
      if (branch.next === id) found.push(['nodes', n, 'branches', b, 'next']);
    }),
  );
  draft.transfer?.targets.forEach((target, t) => {
    if (target.destination.kind === 'node' && target.destination.node === id)
      found.push(['transfer', 'targets', t, 'destination', 'node']);
  });
  return found;
}

/** Renames a node and every reference to it (`root`, branch `next`, `node` transfer destinations). */
export function renameNode(draft: RoutingPointDraft, from: string, to: string): RoutingEditResult {
  if (!RoutingKey.safeParse(to).success)
    return fail('invalid_id', `${to} is not a valid node id (lowercase, digits, - and _)`);
  if (!draft.nodes.some((node) => node.id === from)) return fail('node_unknown', `No node ${from}`);
  if (from !== to && draft.nodes.some((node) => node.id === to))
    return fail('node_exists', `Node ${to} already exists`);
  const next = structuredClone(draft);
  for (const node of next.nodes) {
    if (node.id === from) node.id = to;
    for (const branch of node.branches) if (branch.next === from) branch.next = to;
  }
  if (next.root === from) next.root = to;
  for (const target of next.transfer?.targets ?? [])
    if (target.destination.kind === 'node' && target.destination.node === from)
      target.destination.node = to;
  return { draft: next };
}

/** Renames a branch and the rules of its node that choose it. */
export function renameBranch(
  draft: RoutingPointDraft,
  nodeId: string,
  from: string,
  to: string,
): RoutingEditResult {
  if (!RoutingKey.safeParse(to).success)
    return fail('invalid_id', `${to} is not a valid branch key (lowercase, digits, - and _)`);
  const next = structuredClone(draft);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return fail('node_unknown', `No node ${nodeId}`);
  const branch = node.branches.find((candidate) => candidate.key === from);
  if (!branch) return fail('branch_unknown', `Node ${nodeId} has no branch ${from}`);
  if (from !== to && node.branches.some((candidate) => candidate.key === to))
    return fail('branch_exists', `Node ${nodeId} already has a branch ${to}`);
  branch.key = to;
  for (const engine of node.engines)
    if (engine.kind === 'rules')
      for (const rule of engine.rules) if (rule.branch === from) rule.branch = to;
  return { draft: next };
}

/** Removes a node. The root is refused, and so is a node something still points at. */
export function deleteNode(draft: RoutingPointDraft, id: string): RoutingEditResult {
  if (!draft.nodes.some((node) => node.id === id)) return fail('node_unknown', `No node ${id}`);
  if (draft.root === id) return fail('root_delete', 'The root node cannot be deleted');
  const referrers = routingNodeReferrers(draft, id);
  if (referrers.length)
    return fail(
      'node_referenced',
      `Node ${id} is still the target of ${referrers.length} reference(s)`,
      referrers,
    );
  const next = structuredClone(draft);
  next.nodes = next.nodes.filter((node) => node.id !== id);
  return { draft: next };
}

/**
 * A minimal valid node to start from: an LLM classifier with one catch-all branch to the default
 * target, and a fallback chain that asks again once, then goes to the default.
 */
export function blankRoutingNode(draft: RoutingPointDraft, id: string): RoutingNode {
  const language = draft.language.default;
  return RoutingNode.parse({
    id,
    ask: { [language]: 'How can I help you today?' },
    engines: [{ kind: 'llm', instructions: 'Decide what the caller needs.' }],
    branches: [
      {
        key: 'other',
        description: 'Anything else',
        target: { kind: 'agent', agent: draft.defaultTarget },
      },
    ],
    fallback: [{ kind: 'reask', times: 1 }, { kind: 'default' }],
  });
}

/** Appends a node, or inserts it after `after`. */
export function addNode(
  draft: RoutingPointDraft,
  node: RoutingNode,
  options: { after?: string } = {},
): RoutingEditResult {
  if (!RoutingKey.safeParse(node.id).success)
    return fail('invalid_id', `${node.id} is not a valid node id (lowercase, digits, - and _)`);
  if (draft.nodes.some((candidate) => candidate.id === node.id))
    return fail('node_exists', `Node ${node.id} already exists`);
  if (draft.nodes.length >= ROUTING_LIMITS.nodes)
    return fail('node_limit', `A point has at most ${ROUTING_LIMITS.nodes} nodes`);
  const next = structuredClone(draft);
  const at = options.after === undefined ? -1 : next.nodes.findIndex((n) => n.id === options.after);
  if (options.after !== undefined && at < 0)
    return fail('node_unknown', `No node ${options.after}`);
  next.nodes.splice(at < 0 ? next.nodes.length : at + 1, 0, structuredClone(node));
  return { draft: next };
}

function stepList(node: RoutingNode, list: RoutingStepList): unknown[] {
  return list === 'engines' ? node.engines : list === 'fallback' ? node.fallback : node.branches;
}

/** Reorders the engines, fallback steps or branches of a node: the item at `from` moves to `to`. */
export function moveStep(
  draft: RoutingPointDraft,
  nodeId: string,
  list: RoutingStepList,
  from: number,
  to: number,
): RoutingEditResult {
  const next = structuredClone(draft);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return fail('node_unknown', `No node ${nodeId}`);
  const items = stepList(node, list);
  if (!items[from] || to < 0 || to >= items.length)
    return fail('step_unknown', `No ${list} position ${from} to ${to}`);
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return { draft: next };
}

/** Removes an engine, fallback step or branch; a node keeps at least one of each. */
export function removeStep(
  draft: RoutingPointDraft,
  nodeId: string,
  list: RoutingStepList,
  index: number,
): RoutingEditResult {
  const next = structuredClone(draft);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return fail('node_unknown', `No node ${nodeId}`);
  const items = stepList(node, list);
  if (!items[index]) return fail('step_unknown', `No ${list} position ${index}`);
  if (items.length === 1) return fail('last_step', `A node keeps at least one of ${list}`);
  items.splice(index, 1);
  return { draft: next };
}
