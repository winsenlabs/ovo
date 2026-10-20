'use client';
import { deleteNode, renameNode, type RoutingNode } from '@winsendotai/ovo-contracts';
import { useState } from 'react';
import { LinesEditor } from '../../../components/routing/lines-editor';
import { SwitchField, TextField } from '../../../components/routing/fields';
import { IssueList } from '../../../components/routing/issue-list';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { issuesAt } from '../../../lib/derive/routing-issue-index';
import { editErrorMessage, referrersOf, replaceNode } from '../../../lib/derive/routing-draft-edit';
import { useDesigner } from './designer-context';

/** Name, role in the tree, the question asked, and deleting the question. */
export function NodeIdentity({
  node,
  onRenamed,
  onDeleted,
}: {
  node: RoutingNode;
  onRenamed: (id: string) => void;
  onDeleted: () => void;
}) {
  const { draft, edit, index } = useDesigner();
  const [name, setName] = useState(node.id);
  const [problem, setProblem] = useState<string>();
  const isRoot = draft.root === node.id;
  const leading = referrersOf(draft, node.id);
  const set = (patch: Partial<RoutingNode>) =>
    edit((d) => replaceNode(d, node.id, { ...node, ...patch }));
  const rename = () => {
    const result = renameNode(draft, node.id, name.trim());
    if ('error' in result) return setProblem(editErrorMessage(draft, result.error));
    setProblem(undefined);
    edit(() => result.draft);
    onRenamed(name.trim());
  };
  const remove = () => {
    const result = deleteNode(draft, node.id);
    if ('error' in result) return setProblem(editErrorMessage(draft, result.error));
    edit(() => result.draft);
    onDeleted();
  };
  return (
    <div className="rt-stack">
      <IssueList
        issues={issuesAt(index, node.id, 'node').filter((a) => a.anchor.field !== 'ask')}
      />
      <div className="button-row rt-inline">
        <TextField
          id={`${node.id}-name`}
          label="Question id"
          mono
          value={name}
          error={problem}
          help="Renaming also updates every branch that leads here."
          onChange={(next) => {
            setName(next);
            setProblem(undefined);
          }}
        />
        <button
          type="button"
          className="button"
          disabled={name.trim() === node.id}
          onClick={rename}
        >
          Rename
        </button>
      </div>
      <p className="muted">
        {isRoot
          ? 'This is the first question callers hear.'
          : leading.length
            ? `Reached from ${leading.join(', ')}.`
            : 'Nothing leads here yet, so callers never reach it.'}
      </p>
      {!isRoot && (
        <button
          type="button"
          className="button"
          onClick={() => edit((d) => ({ ...d, root: node.id }))}
        >
          Make this the first question
        </button>
      )}
      <LinesEditor
        label="What the caller hears"
        value={node.ask}
        onChange={(ask) => set({ ask })}
      />
      <IssueList issues={issuesAt(index, node.id, 'node', { field: 'ask' })} />
      <TextField
        id={`${node.id}-sets`}
        label="Remember the answer as"
        mono
        value={node.sets ?? ''}
        help="The chosen branch is stored under this name; the agent reads it as ovo_route_<name>. Use language to set the caller's language."
        onChange={(sets) => set({ sets: sets || undefined })}
      />
      <SwitchField
        label="Use the caller's last words here too"
        checked={node.reuseTurn}
        help="One reply can answer this question and the one before it."
        onChange={(reuseTurn) => set({ reuseTurn })}
      />
      {!isRoot && (
        <>
          <button type="button" className="button danger" onClick={remove}>
            Delete this question
          </button>
          {problem && !name.trim() && <InlineAlert tone="danger">{problem}</InlineAlert>}
        </>
      )}
    </div>
  );
}
