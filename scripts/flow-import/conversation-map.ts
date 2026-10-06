import { routeTargets } from '../../packages/plugin-evaluations/src/jev-eval-flow.ts';
import { convertTemplate, IDLE_END_NODE, type ImportedFlowConfig } from './import-poc-flow.ts';

/**
 * Cross-checks an import against the POC's `docs/conversation-map.md`, the generated map the
 * founder reviews. The map is derived from the same `lib/flow.js`, so a difference means the map is
 * stale or the import lost something: a node or its END marker, an intent edge, or the text of a
 * line the flow speaks. The idle ending is not a flow node (it became `idle`), and the clips and
 * SMS markers the import drops are listed by its notes instead. Empty means they agree.
 */
export function diffConversationMap(
  imported: ImportedFlowConfig,
  markdown: string,
  constants: Record<string, string> = {},
): string[] {
  const { flow } = imported.decision;
  const map = parseConversationMap(markdown);
  map.nodes.delete(`${IDLE_END_NODE} END`);
  const nodes = new Set(flow.nodes.map((node) => marker(node.id, node.end)));
  const edges = new Set<string>();
  for (const node of flow.nodes) {
    const listen = flow.listens.find((candidate) => candidate.id === node.listen);
    for (const intent of listen?.intents ?? [])
      for (const target of routeTargets(intent.next))
        edges.add(`${node.id} -${intent.key}-> ${target}`);
  }
  const differences: string[] = [];
  const compare = (kind: string, ours: Set<string>, theirs: Set<string>) => {
    for (const item of ours)
      if (!theirs.has(item)) differences.push(`${kind} missing from map: ${item}`);
    for (const item of theirs)
      if (!ours.has(item)) differences.push(`${kind} not imported: ${item}`);
  };
  compare('node', nodes, map.nodes);
  compare('edge', edges, map.edges);
  for (const [id, line] of Object.entries(flow.lines)) {
    const clip = map.clips.get(id);
    if (clip === undefined) differences.push(`clip missing from map: ${id}`);
    else if (convertTemplate(clip, constants) !== line)
      differences.push(`clip text differs: ${id}`);
  }
  return differences;
}

const marker = (id: string, end: boolean) => (end ? `${id} END` : id);

export function parseConversationMap(markdown: string) {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const clips = new Map<string, string>();
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const node = /^(\w+)\["\w+<br\/><small>([^<]*)<\/small>"\]$/.exec(line);
    if (node) {
      nodes.add(marker(node[1]!, /\bEND\b/.test(node[2]!)));
      continue;
    }
    const edge = /^(\w+) -- "(\w+)" --> (\w+)$/.exec(line);
    if (edge) {
      edges.add(`${edge[1]} -${edge[2]}-> ${edge[3]}`);
      continue;
    }
    const clip = /^\|\s*`(\w+)`\s*\|[^|]*\|(.*)\|$/.exec(line);
    if (clip) clips.set(clip[1]!, clip[2]!.trim());
  }
  return { nodes, edges, clips };
}
