'use client';
import { useMemo, useState } from 'react';
import type { AgentConfig } from '../../lib/api';
import { ListTextInput } from '../forms/list-text-input';
import { useRowKeys } from '../forms/use-row-keys';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

type Script = NonNullable<AgentConfig['script']>;
type Node = Script['nodes'][number];
type Transition = Node['transitions'][number];

export function diagnoseScript(script: Script): string[] {
  const issues: string[] = [];
  const ids = new Set(script.nodes.map((node) => node.id));
  if (ids.size !== script.nodes.length) issues.push('Node IDs must be unique.');
  if (!ids.has(script.start)) issues.push('The start node does not exist.');
  for (const node of script.nodes) {
    if (!node.id.trim()) issues.push('Every node needs an ID.');
    if (!node.prompt.trim()) issues.push(`${node.id || 'A node'} needs a prompt.`);
    if (node.terminal && node.transitions.length)
      issues.push(`${node.id} is terminal but still has transitions.`);
    for (const transition of node.transitions) {
      if (!ids.has(transition.to))
        issues.push(`${node.id} points to missing node ${transition.to}.`);
      if (!transition.matches.length) issues.push(`${node.id} has a transition without matches.`);
      if (
        transition.event === 'dtmf' &&
        transition.matches.some((match) => !/^[0-9*#]$/.test(match))
      )
        issues.push(`${node.id} has an invalid DTMF match.`);
    }
  }
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    script.nodes.find((node) => node.id === id)?.transitions.forEach((edge) => visit(edge.to));
  };
  visit(script.start);
  script.nodes
    .filter((node) => !reached.has(node.id))
    .forEach((node) => issues.push(`${node.id} is unreachable.`));
  return [...new Set(issues)];
}

const emptyScript = (): Script => ({
  start: 'start',
  maxVisits: 20,
  nodes: [{ id: 'start', prompt: '', terminal: true, transitions: [] }],
});

export function ScriptEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const script = config.script;
  const rowKeys = useRowKeys(script?.nodes.length ?? 0);
  const [source, setSource] = useState('');
  const [importError, setImportError] = useState<string>();
  const diagnostics = useMemo(() => (script ? diagnoseScript(script) : []), [script]);
  const setScript = (next: Script | undefined) => update({ ...config, script: next });
  const patchNode = (index: number, patch: Partial<Node>) =>
    script &&
    setScript({
      ...script,
      nodes: script.nodes.map((node, current) =>
        current === index ? { ...node, ...patch } : node,
      ),
    });
  const patchTransition = (nodeIndex: number, edgeIndex: number, patch: Partial<Transition>) => {
    if (!script) return;
    const node = script.nodes[nodeIndex]!;
    patchNode(nodeIndex, {
      transitions: node.transitions.map((edge, current) =>
        current === edgeIndex ? { ...edge, ...patch } : edge,
      ),
    });
  };
  function applyImport() {
    try {
      const parsed = JSON.parse(source) as Script;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes))
        throw new Error('Script requires a nodes array.');
      rowKeys.reset();
      setScript(parsed);
      setImportError(undefined);
      setSource('');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Script JSON is invalid.');
    }
  }
  return (
    <Panel labelledBy="script-title">
      <PanelHeader
        id="script-title"
        title="Deterministic script"
        badge={
          <StatusBadge tone={script && !diagnostics.length ? 'good' : 'warning'}>
            {script ? `${script.nodes.length} nodes` : 'Not configured'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <p className="muted">
          Scripts are available for announcement and FAQ modes. The table is the accessible
          authoring surface; JSON import is optional.
        </p>
        {!script ? (
          <EmptyState title="No script graph">
            Direct message or FAQ behavior remains active.
            <button className="button" type="button" onClick={() => setScript(emptyScript())}>
              Create script
            </button>
          </EmptyState>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Start node" htmlFor="script-start">
                <select
                  id="script-start"
                  value={script.start}
                  onChange={(event) => setScript({ ...script, start: event.target.value })}
                >
                  {script.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Maximum node visits" htmlFor="script-visits">
                <input
                  id="script-visits"
                  type="number"
                  min={1}
                  max={100}
                  value={script.maxVisits}
                  onChange={(event) =>
                    setScript({ ...script, maxVisits: Number(event.target.value) })
                  }
                />
              </Field>
            </div>
            {diagnostics.length > 0 && (
              <Notice tone="danger">
                <strong>Script diagnostics</strong>
                <ul>
                  {diagnostics.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </Notice>
            )}
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
                          <ListTextInput id={`script-matches-${nodeIndex}-${edgeIndex}`} rows={2} value={edge.matches}
                            onChange={matches => patchTransition(nodeIndex, edgeIndex, { matches })} />
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
                                transitions: node.transitions.filter(
                                  (_, current) => current !== edgeIndex,
                                ),
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
            <div className="button-row">
              <button
                className="button"
                type="button"
                onClick={() => {
                  rowKeys.insert(script.nodes.length);
                  setScript({
                    ...script,
                    nodes: [
                      ...script.nodes,
                      {
                        id: `node-${script.nodes.length + 1}`,
                        prompt: '',
                        terminal: false,
                        transitions: [],
                      },
                    ],
                  });
                }}
              >
                Add node
              </button>
              <button className="button danger" type="button" onClick={() => setScript(undefined)}>
                Remove script
              </button>
            </div>
          </>
        )}
        <details className="import-box">
          <summary>Import script JSON</summary>
          <Field label="Validated ScriptGraph JSON" htmlFor="script-import" error={importError}>
            <textarea
              id="script-import"
              className="code-input"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-invalid={Boolean(importError)}
            />
          </Field>
          <button className="button" type="button" disabled={!source.trim()} onClick={applyImport}>
            Validate and replace script
          </button>
        </details>
      </div>
    </Panel>
  );
}
