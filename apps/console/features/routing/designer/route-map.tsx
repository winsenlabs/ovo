'use client';
import { useMemo } from 'react';
import { SectionCard } from '../../../components/ui/section-card';
import { ENGINE_LABEL, targetSummary } from '../../../lib/derive/routing-labels';
import { layoutMap } from '../../../lib/derive/routing-map';
import { outlineOrder } from '../../../lib/derive/routing-labels';
import { useDesigner, useNames } from './designer-context';

const flagFor = (errors: number, warnings: number) => (errors ? 'danger' : warnings ? 'warn' : '');

/**
 * The tree drawn out, read only: questions as boxes, branches as lines, destinations as pills. On
 * a phone only the outline below is shown. The drawing is a picture for the eye; the outline is
 * the same information as a list and the way to open a question from the keyboard.
 */
export function RouteMap({ onOpen }: { onOpen: (nodeId: string) => void }) {
  const { draft, index } = useDesigner();
  const names = useNames();
  const map = useMemo(() => layoutMap(draft, names, (k) => ENGINE_LABEL[k as keyof typeof ENGINE_LABEL] ?? k), [draft, names]);
  const rows = useMemo(() => outlineOrder(draft.nodes, draft.root), [draft.nodes, draft.root]);
  const targets = map.boxes.filter((b) => b.kind === 'target').length;
  const label = `Route map: ${draft.nodes.length} question${draft.nodes.length === 1 ? '' : 's'} and ${targets} destination${targets === 1 ? '' : 's'}, starting at ${draft.root}. The outline below lists the same.`;
  return (
    <SectionCard title="Route map" description="How a call moves through the questions. Select a question to edit it.">
      <div className="rt-map-scroll">
        <svg className="rt-map" width={map.width} height={map.height} viewBox={`0 0 ${map.width} ${map.height}`} role="img" aria-label={label}>
          {map.edges.map((edge) => (
            <path key={`${edge.from}>${edge.to}>${edge.label}`} d={edge.path} className="rt-map-edge" fill="none" />
          ))}
          {map.boxes.map((box) => {
            const issues = box.kind === 'node' ? (index.byNode.get(box.id) ?? []) : [];
            const errors = issues.filter((a) => a.issue.severity === 'error').length;
            const flag = flagFor(errors, issues.length - errors);
            return (
              <g
                key={box.id}
                className={`rt-map-${box.kind}${flag ? ` flag-${flag}` : ''}`}
                transform={`translate(${box.x},${box.y})`}
                onClick={box.kind === 'node' ? () => onOpen(box.nodeId) : undefined}
              >
                <rect width={box.w} height={box.h} rx={box.kind === 'node' ? 8 : box.h / 2} />
                <text x={10} y={box.kind === 'node' ? 19 : box.h / 2 + 4} className="rt-map-title">
                  {box.title.length > 22 ? `${box.title.slice(0, 21)}…` : box.title}
                </text>
                {box.subtitle && (
                  <text x={10} y={36} className="rt-map-sub">
                    {box.subtitle.length > 26 ? `${box.subtitle.slice(0, 25)}…` : box.subtitle}
                  </text>
                )}
                {issues.length > 0 && (
                  <text x={box.w - 8} y={16} textAnchor="end" className="rt-map-flag">
                    {errors ? `${errors} !` : `${issues.length} ?`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <ol className="rt-outline" aria-label="Route map as an outline">
        {rows.map(({ node, depth, reachable }) => (
          <li key={node.id} style={{ paddingInlineStart: `${depth * 16}px` }}>
            <button type="button" className="text-button" onClick={() => onOpen(node.id)}>
              {node.id}
            </button>
            {draft.root === node.id && <span className="ds-chip">first question</span>}
            {!reachable && <span className="ds-chip">unreachable</span>}
            <ul>
              {node.branches.map((b) => (
                <li key={b.key}>
                  <span className="mono">{b.key}</span> → {b.next !== undefined ? b.next : targetSummary(b.target!, names)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
