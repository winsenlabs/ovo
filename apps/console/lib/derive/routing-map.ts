import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { targetSummary } from './routing-labels';

export const BOX_W = 168;
export const BOX_H = 46;
export const PILL_H = 28;
export const GAP_X = 56;
export const GAP_Y = 14;

export interface MapBox {
  id: string;
  kind: 'node' | 'target';
  nodeId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
}
export interface MapEdge {
  from: string;
  to: string;
  label: string;
  path: string;
}

/**
 * A left-to-right drawing of the tree: each question a box, each branch an edge to the next
 * question or to a pill naming where the call goes. A question reached twice is drawn once and
 * joined from both. Positions are computed here so the layout is testable without a browser.
 */
export function layoutMap(
  draft: RoutingPointDraft,
  names: Parameters<typeof targetSummary>[1] = {},
  engineLabel: (kind: string) => string = (k) => k,
): { boxes: MapBox[]; edges: MapEdge[]; width: number; height: number } {
  const byId = new Map(draft.nodes.map((n) => [n.id, n]));
  const boxes = new Map<string, MapBox>();
  const edges: MapEdge[] = [];
  const pending: { from: string; to: string; label: string }[] = [];
  let row = 0;
  const place = (id: string, depth: number): number => {
    const node = byId.get(id)!;
    const childYs: number[] = [];
    const x = depth * (BOX_W + GAP_X);
    boxes.set(id, {
      id,
      kind: 'node',
      nodeId: id,
      x,
      y: 0,
      w: BOX_W,
      h: BOX_H,
      title: id,
      subtitle: node.engines.map((e) => engineLabel(e.kind)).join(' + '),
    });
    for (const branch of node.branches) {
      if (branch.next !== undefined && byId.has(branch.next)) {
        if (boxes.has(branch.next)) pending.push({ from: id, to: branch.next, label: branch.key });
        else {
          childYs.push(place(branch.next, depth + 1));
          pending.push({ from: id, to: branch.next, label: branch.key });
        }
      } else if (branch.target) {
        const pillId = `${id}/${branch.key}`;
        const y = row * (BOX_H + GAP_Y);
        row += 1;
        boxes.set(pillId, {
          id: pillId,
          kind: 'target',
          nodeId: id,
          x: x + BOX_W + GAP_X,
          y: y + (BOX_H - PILL_H) / 2,
          w: BOX_W,
          h: PILL_H,
          title: targetSummary(branch.target, names),
          subtitle: '',
        });
        childYs.push(y);
        pending.push({ from: id, to: pillId, label: branch.key });
      }
    }
    const y = childYs.length
      ? (Math.min(...childYs) + Math.max(...childYs)) / 2
      : row++ * (BOX_H + GAP_Y);
    boxes.get(id)!.y = y;
    return y;
  };
  if (byId.has(draft.root)) place(draft.root, 0);
  for (const node of draft.nodes) if (!boxes.has(node.id)) place(node.id, 0);
  for (const { from, to, label } of pending) {
    const a = boxes.get(from)!;
    const b = boxes.get(to)!;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mid = (x1 + x2) / 2;
    edges.push({ from, to, label, path: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` });
  }
  const all = [...boxes.values()];
  return {
    boxes: all,
    edges,
    width: Math.max(...all.map((b) => b.x + b.w), BOX_W) + 8,
    height: Math.max(...all.map((b) => b.y + b.h), BOX_H) + 8,
  };
}
