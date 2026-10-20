import {
  RoutingKey,
  routingNodeReferrers,
  type HoldPolicy,
  type RoutingEditError,
  type RoutingNode,
  type RoutingPath,
  type RoutingPointDraft,
  type RoutingTarget,
} from '@winsendotai/ovo-contracts';

/**
 * Draft edits the designer needs on top of the contract's `renameNode`, `deleteNode`, `addNode` and
 * `renameBranch` (which the console imports as they are, so the preview and the designer agree).
 */
export type QueueEditResult = { draft: RoutingPointDraft } | { error: string };

const KEY_HELP = 'Use lowercase letters, digits, - or _, starting with a letter (80 at most).';

export const isRoutingKey = (value: string) => RoutingKey.safeParse(value).success;

/** Who names a node, in words: `intent > support`, `transfer target billing`, `the first question`. */
export function describeReferrers(draft: RoutingPointDraft, referrers: RoutingPath[]): string[] {
  return referrers.map((path) => {
    if (path[0] === 'root') return 'the first question';
    if (path[0] === 'transfer') return `transfer target ${draft.transfer?.targets[Number(path[2])]?.key}`;
    const node = draft.nodes[Number(path[1])];
    return `${node?.id} > ${node?.branches[Number(path[3])]?.key}`;
  });
}

/** Where the node is reached from, for the "Reached from" line (branches and transfer targets). */
export const referrersOf = (draft: RoutingPointDraft, id: string) =>
  describeReferrers(draft, routingNodeReferrers(draft, id));

/** A contract edit refusal as one sentence for the person editing. */
export function editErrorMessage(draft: RoutingPointDraft, error: RoutingEditError): string {
  switch (error.code) {
    case 'invalid_id':
      return KEY_HELP;
    case 'root_delete':
      return 'The first question cannot be deleted. Make another node the root first.';
    case 'node_referenced':
      return `Still used by ${describeReferrers(draft, error.referrers ?? []).join(', ')}.`;
    default:
      return `${error.message}.`;
  }
}

/** Replace one node by id, keeping its place. */
export function replaceNode(
  draft: RoutingPointDraft,
  id: string,
  node: RoutingNode,
): RoutingPointDraft {
  return { ...draft, nodes: draft.nodes.map((n) => (n.id === id ? node : n)) };
}

/** Rename a queue binding's key and every `human` step, target and hold that names it. */
export function renameQueueKey(
  draft: RoutingPointDraft,
  from: string,
  to: string,
): QueueEditResult {
  if (from === to) return { draft };
  if (!isRoutingKey(to)) return { error: KEY_HELP };
  const bindings = draft.humanQueues ?? [];
  if (!bindings.some((b) => b.key === from)) return { error: `No queue bound as ${from}.` };
  if (bindings.some((b) => b.key === to)) return { error: `A queue is already bound as ${to}.` };
  const holdOf = <T extends { onTimeout: HoldPolicy['onTimeout'] }>(hold: T | undefined) =>
    hold && {
      ...hold,
      onTimeout: hold.onTimeout.map((s) =>
        s.kind === 'human' && s.queueId === from ? { ...s, queueId: to } : s,
      ),
    };
  const target = (t: RoutingTarget | undefined): RoutingTarget | undefined =>
    t?.kind === 'human' && t.queueId === from ? { ...t, queueId: to } : t;
  return {
    draft: {
      ...draft,
      humanQueues: bindings.map((b) => (b.key === from ? { ...b, key: to } : b)),
      nodes: draft.nodes.map((node) => ({
        ...node,
        branches: node.branches.map((b) =>
          b.target ? { ...b, target: target(b.target) } : b,
        ) as RoutingNode['branches'],
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
          destination:
            t.destination.kind === 'human' && t.destination.queueId === from
              ? { ...t.destination, queueId: to }
              : t.destination,
        })),
      },
    },
  };
}
