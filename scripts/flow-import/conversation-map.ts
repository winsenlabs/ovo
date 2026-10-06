import type { FlowDocument } from '../../packages/plugin-evaluations/src/jev-eval-flow.ts';
import { convertTemplate } from './import-poc-flow.ts';

/**
 * Cross-checks an imported flow against the POC's `docs/conversation-map.md`, the generated map the
 * founder reviews. The map is derived from the same `lib/flow.js`, so any difference means the map
 * is stale or the import lost something: every node with its markers, every intent edge, and every
 * clip's text. Returns the differences, one line each; empty means they agree.
 */
export function diffConversationMap(
  flow: FlowDocument,
  markdown: string,
  constants: Record<string, string> = {},
): string[] {
  const map = parseConversationMap(markdown);
  const expected = flowGraph(flow);
  const differences: string[] = [];
  const compare = (kind: string, ours: Set<string>, theirs: Set<string>) => {
    for (const item of ours)
      if (!theirs.has(item)) differences.push(`${kind} missing from map: ${item}`);
    for (const item of theirs)
      if (!ours.has(item)) differences.push(`${kind} not imported: ${item}`);
  };
  compare('node', expected.nodes, map.nodes);
  compare('edge', expected.edges, map.edges);
  for (const [id, text] of map.clips) {
    const line = flow.lines[id];
    if (line === undefined) differences.push(`clip not imported: ${id}`);
    else if (line !== convertTemplate(text, constants))
      differences.push(`clip text differs: ${id}`);
  }
  for (const id of Object.keys(flow.lines))
    if (!map.clips.has(id)) differences.push(`clip missing from map: ${id}`);
  return differences;
}

/** Nodes as `id END? SMS:kind?` and edges as `from -intent-> to`, the way the map draws them. */
function flowGraph(flow: FlowDocument) {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const [id, node] of Object.entries(flow.nodes)) {
    const sms = node.actions?.find((action) => action.startsWith('send_sms:'));
    nodes.add(marker(id, sms?.slice('send_sms:'.length), node.end === true));
    if (!node.listen) continue;
    for (const [intent, { next }] of Object.entries(flow.listens[node.listen]!.intents)) {
      const targets =
        typeof next === 'string' ? [next] : [...Object.values(next.cases), next.otherwise];
      for (const target of new Set(targets)) edges.add(`${id} -${intent}-> ${target}`);
    }
  }
  return { nodes, edges };
}

const marker = (id: string, sms: string | undefined, end: boolean) =>
  [id, end ? 'END' : '', sms ? `SMS:${sms}` : ''].filter(Boolean).join(' ');

export function parseConversationMap(markdown: string) {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const clips = new Map<string, string>();
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const node = /^(\w+)\["\w+<br\/><small>([^<]*)<\/small>"\]$/.exec(line);
    if (node) {
      const extras = node[2]!.split(' · ').slice(1).join(' ');
      nodes.add(marker(node[1]!, /SMS:(\w+)/.exec(extras)?.[1], /\bEND\b/.test(extras)));
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
