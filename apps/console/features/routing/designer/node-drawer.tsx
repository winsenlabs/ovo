'use client';
import { Dialog } from '../../../components/ui/dialog';
import { replaceNode } from '../../../lib/derive/routing-edit';
import { BranchList } from './branch-list';
import { useDesigner } from './designer-context';
import { EngineList } from './engine-list';
import { FallbackEditor } from './fallback-editor';
import { NodeIdentity } from './node-identity';

/**
 * One question of the tree, in a wide drawer (full screen on a phone): identity and the question
 * asked, the engines that decide, the branches that follow and the fallback chain. Every edit
 * goes straight into the working copy; the header Save persists it.
 */
export function NodeDrawer({
  nodeId,
  onClose,
  onOpenNode,
}: {
  nodeId: string | undefined;
  onClose: () => void;
  onOpenNode: (id: string) => void;
}) {
  const { draft, edit, canEdit } = useDesigner();
  const node = draft.nodes.find((n) => n.id === nodeId);
  const set = (next: NonNullable<typeof node>) => edit((d) => replaceNode(d, next.id, next));
  return (
    <Dialog
      open={nodeId !== undefined && node !== undefined}
      onClose={onClose}
      title={`Question: ${nodeId ?? ''}`}
      className="ui-drawer rt-drawer-wide"
    >
      <div className="ui-drawer-head">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
      {node && (
        <fieldset className="rt-readonly" disabled={!canEdit}>
          {!canEdit && <p className="muted">Viewers can read the tree; editors can change it.</p>}
          <section className="queue-section" aria-label="Question">
            <h3>Question</h3>
            <NodeIdentity node={node} onRenamed={onOpenNode} onDeleted={onClose} />
          </section>
          <section className="queue-section" aria-label="Engines">
            <h3>How it decides</h3>
            <EngineList node={node} onChange={set} />
          </section>
          <section className="queue-section" aria-label="Branches">
            <h3>Branches</h3>
            <BranchList node={node} onOpenNode={onOpenNode} />
          </section>
          <section className="queue-section" aria-label="Fallback">
            <h3>When it cannot decide</h3>
            <FallbackEditor node={node} onChange={set} />
          </section>
        </fieldset>
      )}
    </Dialog>
  );
}
