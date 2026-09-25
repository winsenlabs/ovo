'use client';
import type { AgentConfig } from '../../lib/api';
import { ResponsiveTable } from '../primitives';
import { ListTextInput } from '../forms/list-text-input';
type Script = NonNullable<AgentConfig['script']>;
type Node = Script['nodes'][number];
type Transition = Node['transitions'][number];
export function ScriptNodesTable({
  script,
  rowKeys,
  patchNode,
  patchTransition,
  setScript,
}: {
  script: Script;
  rowKeys: { keyAt: (index: number) => string; remove: (index: number) => void };
  patchNode: (index: number, patch: Partial<Node>) => void;
  patchTransition: (nodeIndex: number, edgeIndex: number, patch: Partial<Transition>) => void;
  setScript: (next: Script | undefined) => void;
}) {
  return (
    <ResponsiveTable label="Script nodes and transitions">
      <thead>
        <tr>
          <th>Node</th>
          <th>Prompt</th>
          <th>Terminal</th>
          <th>Transitions</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {script.nodes.map((node, nodeIndex) => (
          <tr key={rowKeys.keyAt(nodeIndex)}>
            <td>
              <label className="sr-only" htmlFor={`node-id-${nodeIndex}`}>
                Node {nodeIndex + 1} ID
              </label>
              <input
                id={`node-id-${nodeIndex}`}
                value={node.id}
                onChange={(event) => patchNode(nodeIndex, { id: event.target.value })}
              />
            </td>
            <td>
              <label className="sr-only" htmlFor={`node-prompt-${nodeIndex}`}>
                Prompt for {node.id}
              </label>
              <textarea
                id={`node-prompt-${nodeIndex}`}
                value={node.prompt}
                onChange={(event) => patchNode(nodeIndex, { prompt: event.target.value })}
              />
            </td>
            <td>
              <input
                aria-label={`${node.id} terminal`}
                type="checkbox"
                checked={node.terminal}
                onChange={(event) =>
                  patchNode(nodeIndex, {
                    terminal: event.target.checked,
                    ...(event.target.checked ? { transitions: [] } : {}),
                  })
                }
              />
            </td>
            <td>
              {node.transitions.map((edge, edgeIndex) => (
                <fieldset className="transition-row" key={edgeIndex}>
                  <legend>Transition {edgeIndex + 1}</legend>
                  <select
                    aria-label="Event"
                    value={edge.event}
                    onChange={(event) =>
                      patchTransition(nodeIndex, edgeIndex, {
                        event: event.target.value as Transition['event'],
                      })
                    }
                  >
                    <option value="text">Text</option>
                    <option value="dtmf">DTMF</option>
                  </select>
                  <ListTextInput
                    id={`script-matches-${nodeIndex}-${edgeIndex}`}
                    rows={2}
                    value={edge.matches}
                    onChange={(matches) => patchTransition(nodeIndex, edgeIndex, { matches })}
                  />
                  <select
                    aria-label="Target node"
                    value={edge.to}
                    onChange={(event) =>
                      patchTransition(nodeIndex, edgeIndex, { to: event.target.value })
                    }
                  >
                    {script.nodes.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.id}
                      </option>
                    ))}
                  </select>
                  <button
                    className="text-button danger-text"
                    type="button"
                    onClick={() =>
                      patchNode(nodeIndex, {
                        transitions: node.transitions.filter((_, current) => current !== edgeIndex),
                      })
                    }
                  >
                    Remove
                  </button>
                </fieldset>
              ))}
              {!node.terminal && (
                <button
                  className="button small"
                  type="button"
                  onClick={() =>
                    patchNode(nodeIndex, {
                      transitions: [
                        ...node.transitions,
                        { event: 'text', matches: ['continue'], to: script.start },
                      ],
                    })
                  }
                >
                  Add transition
                </button>
              )}
            </td>
            <td>
              <button
                className="text-button danger-text"
                type="button"
                disabled={script.nodes.length === 1}
                onClick={() => {
                  rowKeys.remove(nodeIndex);
                  setScript({
                    ...script,
                    nodes: script.nodes.filter((_, current) => current !== nodeIndex),
                  });
                }}
              >
                Remove
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </ResponsiveTable>
  );
}
