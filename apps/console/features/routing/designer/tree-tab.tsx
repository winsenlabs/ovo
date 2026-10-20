'use client';
import { useState } from 'react';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { blankNode, freshKey } from '../../../lib/derive/routing-defaults';
import { addNode } from '../../../lib/derive/routing-edit';
import { useDesigner } from './designer-context';
import { NodeDrawer } from './node-drawer';
import { TreeOutline } from './tree-outline';

export const TREE_KEYS: readonly [string, string][] = [
  ['Up / Down', 'Move between questions and branches'],
  ['Right', 'Open a closed item, or step into its first child'],
  ['Left', 'Close an open item, or step out to its parent'],
  ['Home / End', 'First or last item'],
  ['Enter or Space', "Open the question's editor"],
];

/** The Tree tab: the question tree, keyboard help, and the drawer for the open question. */
export function TreeTab({ openId, onOpen }: { openId: string | undefined; onOpen: (id: string | undefined) => void }) {
  const { draft, edit, canEdit } = useDesigner();
  const [problem, setProblem] = useState<string>();
  const add = () => {
    const id = freshKey('question', draft.nodes.map((n) => n.id));
    const result = addNode(draft, blankNode(id, draft.defaultTarget));
    if ('error' in result) return setProblem(result.error);
    setProblem(undefined);
    edit(() => result.draft);
    onOpen(id);
  };
  return (
    <div className="rt-stack rt-pad">
      <div className="rt-toolbar">
        <p className="muted">
          Each question greets the caller with what to say or press, decides, and sends the call on.
          Open one to edit how it decides, its branches and its fallback.
        </p>
        {canEdit && (
          <button type="button" className="button" onClick={add}>
            Add question
          </button>
        )}
      </div>
      {problem && <InlineAlert tone="danger">{problem}</InlineAlert>}
      <TreeOutline selected={openId} onOpen={onOpen} />
      <details className="rt-keys">
        <summary>Keyboard help</summary>
        <dl>
          {TREE_KEYS.map(([keys, does]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{does}</dd>
            </div>
          ))}
        </dl>
      </details>
      <NodeDrawer nodeId={openId} onClose={() => onOpen(undefined)} onOpenNode={onOpen} />
    </div>
  );
}
