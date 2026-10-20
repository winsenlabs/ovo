'use client';
import {
  ROUTING_LIMITS,
  addNode,
  renameBranch,
  type RoutingBranch,
  type RoutingNode,
} from '@winsendotai/ovo-contracts';
import { TextAreaField, SelectField } from '../../../components/routing/fields';
import { KeyInput } from '../../../components/routing/key-input';
import { IssueList } from '../../../components/routing/issue-list';
import { issuesAt } from '../../../lib/derive/routing-issue-index';
import {
  blankBranch,
  blankNode,
  blankTarget,
  freshKey,
} from '../../../lib/derive/routing-defaults';
import { editErrorMessage, replaceNode } from '../../../lib/derive/routing-draft-edit';
import { moveItem } from '../../../lib/derive/list-edit';
import { useDesigner } from './designer-context';
import { TargetEditor } from './target-editor';

const NEW_NODE = '__new__';

/** The ways a question can go: each branch has a description the model reads and a destination. */
export function BranchList({
  node,
  onOpenNode,
}: {
  node: RoutingNode;
  onOpenNode: (id: string) => void;
}) {
  const { draft, edit, index } = useDesigner();
  const setBranch = (b: number, branch: RoutingBranch) =>
    edit((d) =>
      replaceNode(d, node.id, {
        ...node,
        branches: node.branches.map((x, i) => (i === b ? branch : x)),
      }),
    );
  const otherNodes = draft.nodes.filter((n) => n.id !== node.id);
  const newChild = (b: number) => {
    const id = freshKey(
      'question',
      draft.nodes.map((n) => n.id),
    );
    edit((d) => {
      const added = addNode(
        replaceNode(d, node.id, {
          ...node,
          branches: node.branches.map((x, i) =>
            i === b ? { key: x.key, description: x.description, next: id } : x,
          ),
        }),
        blankNode(id, d.defaultTarget),
      );
      return 'draft' in added ? added.draft : d;
    });
    onOpenNode(id);
  };
  const remove = (b: number) => {
    const key = node.branches[b]!.key;
    edit((d) =>
      replaceNode(d, node.id, {
        ...node,
        branches: node.branches.filter((_, i) => i !== b),
        engines: node.engines.map((e) =>
          e.kind === 'rules' ? { ...e, rules: e.rules.filter((r) => r.branch !== key) } : e,
        ),
      }),
    );
  };
  return (
    <div className="rt-stack">
      <ol className="queue-rows" aria-label="Branches">
        {node.branches.map((branch, b) => {
          const mode = branch.next !== undefined ? 'next' : 'target';
          const id = `${node.id}-b${b}`;
          return (
            <li key={b} className="rt-card">
              <div className="rt-card-head">
                <KeyInput
                  id={`${id}-key`}
                  label="Branch key"
                  value={branch.key}
                  error={
                    issuesAt(index, node.id, 'branch', { branchKey: branch.key, field: 'key' })[0]
                      ?.issue.message
                  }
                  onCommit={(to) => {
                    const result = renameBranch(draft, node.id, branch.key, to);
                    if ('error' in result) return editErrorMessage(draft, result.error);
                    edit(() => result.draft);
                    return undefined;
                  }}
                />
                <span className="rt-row-actions">
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Move branch ${branch.key} up`}
                    disabled={b === 0}
                    onClick={() =>
                      edit((d) =>
                        replaceNode(d, node.id, {
                          ...node,
                          branches: moveItem(node.branches, b, -1),
                        }),
                      )
                    }
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Move branch ${branch.key} down`}
                    disabled={b === node.branches.length - 1}
                    onClick={() =>
                      edit((d) =>
                        replaceNode(d, node.id, {
                          ...node,
                          branches: moveItem(node.branches, b, 1),
                        }),
                      )
                    }
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Remove branch ${branch.key}`}
                    disabled={node.branches.length <= 1}
                    onClick={() => remove(b)}
                  >
                    Remove
                  </button>
                </span>
              </div>
              <TextAreaField
                id={`${id}-description`}
                label="What this means"
                rows={2}
                value={branch.description}
                help="The model reads this to choose; it never sees where the branch leads."
                onChange={(description) => setBranch(b, { ...branch, description })}
              />
              <SelectField
                id={`${id}-mode`}
                label="Then"
                value={mode}
                options={[
                  { value: 'next', label: 'Ask another question' },
                  { value: 'target', label: 'Send the call somewhere' },
                ]}
                onChange={(next) =>
                  setBranch(
                    b,
                    next === 'next'
                      ? {
                          key: branch.key,
                          description: branch.description,
                          next: otherNodes[0]?.id ?? '',
                        }
                      : {
                          key: branch.key,
                          description: branch.description,
                          target: blankTarget('agent'),
                        },
                  )
                }
              />
              {mode === 'next' ? (
                <div className="rt-stack">
                  <SelectField
                    id={`${id}-next`}
                    label="Next question"
                    value={branch.next ?? ''}
                    placeholder="Choose a question…"
                    options={[
                      ...otherNodes.map((n) => ({ value: n.id, label: n.id })),
                      { value: NEW_NODE, label: 'New question…' },
                    ]}
                    error={
                      issuesAt(index, node.id, 'branch', {
                        branchKey: branch.key,
                        field: 'next',
                      })[0]?.issue.message
                    }
                    onChange={(next) =>
                      next === NEW_NODE ? newChild(b) : setBranch(b, { ...branch, next })
                    }
                  />
                  {branch.next && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onOpenNode(branch.next!)}
                    >
                      Open {branch.next}
                    </button>
                  )}
                </div>
              ) : (
                <TargetEditor
                  id={`${id}-target`}
                  value={branch.target!}
                  onChange={(target) =>
                    setBranch(b, { key: branch.key, description: branch.description, target })
                  }
                />
              )}
              <IssueList
                issues={issuesAt(index, node.id, 'branch', { branchKey: branch.key }).filter(
                  (a) => !['key', 'next'].includes(a.anchor.field ?? ''),
                )}
              />
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="button"
        disabled={node.branches.length >= ROUTING_LIMITS.branchesPerNode}
        onClick={() =>
          edit((d) =>
            replaceNode(d, node.id, {
              ...node,
              branches: [
                ...node.branches,
                blankBranch(
                  freshKey(
                    'option',
                    node.branches.map((x) => x.key),
                  ),
                  d.defaultTarget,
                ),
              ],
            }),
          )
        }
      >
        Add branch
      </button>
    </div>
  );
}
