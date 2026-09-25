import type { AgentConfig } from '../../lib/api';

type Script = NonNullable<AgentConfig['script']>;
type Edit = { kind: 'rename'; index: number; id: string } | { kind: 'delete'; index: number };

export function editScriptNode(
  script: Script,
  edit: Edit,
): { script?: Script; error?: string; notice?: string } {
  const node = script.nodes[edit.index];
  if (!node) return { error: 'The node no longer exists.' };
  if (new Set(script.nodes.map((item) => item.id)).size !== script.nodes.length)
    return { error: 'Resolve duplicate node IDs before changing references.' };
  if (edit.kind === 'rename') {
    const id = edit.id.trim();
    if (!id) return { error: 'Node ID is required.' };
    if (script.nodes.some((item, index) => index !== edit.index && item.id === id))
      return { error: `Node ID ${id} already exists.` };
    if (id === node.id) return { script };
    return {
      script: {
        ...script,
        start: script.start === node.id ? id : script.start,
        nodes: script.nodes.map((item, index) => ({
          ...item,
          id: index === edit.index ? id : item.id,
          transitions: item.transitions.map((edge) => ({
            ...edge,
            to: edge.to === node.id ? id : edge.to,
          })),
        })),
      },
    };
  }
  if (script.nodes.length === 1) return { error: 'The script needs at least one node.' };
  const nodes = script.nodes
    .filter((_, index) => index !== edit.index)
    .map((item) => ({
      ...item,
      transitions: item.transitions.filter((edge) => edge.to !== node.id),
    }));
  const removedEdges = script.nodes.reduce(
    (count, item) => count + item.transitions.filter((edge) => edge.to === node.id).length,
    0,
  );
  return {
    notice: `Removed ${node.id} and ${removedEdges} incoming transition${removedEdges === 1 ? '' : 's'}.${script.start === node.id ? ` Start node is now ${nodes[0]!.id}.` : ''}`,
    script: {
      ...script,
      start: script.start === node.id ? nodes[0]!.id : script.start,
      nodes,
    },
  };
}
