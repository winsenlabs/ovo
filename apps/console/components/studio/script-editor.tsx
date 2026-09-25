'use client';
import { useMemo, useState } from 'react';
import type { AgentConfig } from '../../lib/api';
import { useRowKeys } from '../forms/use-row-keys';
import { ScriptNodesTable } from './script-nodes-table';
import { EmptyState, Field, Panel, PanelHeader, StatusBadge } from '../primitives';

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
  const renameNode = (index: number, id: string) => {
    if (!script) return;
    const previousId = script.nodes[index]?.id;
    if (previousId === undefined) return;
    setScript({
      ...script,
      start: script.start === previousId ? id : script.start,
      nodes: script.nodes.map((node, current) => ({
        ...node,
        id: current === index ? id : node.id,
        transitions: node.transitions.map((edge) => ({
          ...edge,
          to: edge.to === previousId ? id : edge.to,
        })),
      })),
    });
  };
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
              <div className="field-error" role="alert">
                <strong>Script diagnostics</strong>
                <ul>
                  {diagnostics.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            <ScriptNodesTable
              script={script}
              rowKeys={rowKeys}
              patchNode={patchNode}
              renameNode={renameNode}
              patchTransition={patchTransition}
              setScript={setScript}
            />
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
