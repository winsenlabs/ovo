'use client';
import type { AgentConfig } from '../../lib/api';
import { EmptyState, Panel, PanelHeader, StatusBadge } from '../primitives';
import { useRowKeys } from '../forms/use-row-keys';
import { ToolRow } from './tool-row';

type Tool = AgentConfig['tools'][number];
const emptyTool = (): Tool => ({
  id: crypto.randomUUID(),
  description: '',
  connector: 'http',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  effect: 'read',
  confirmation: false,
  timeoutMs: 10000,
  http: { endpoint: 'https://', method: 'POST', responseType: 'json' },
});

export function ToolsEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const rowKeys = useRowKeys(config.tools.length);
  const setTools = (tools: Tool[]) =>
    update({
      ...config,
      tools,
      allowedTools: config.allowedTools.filter((id) => tools.some((tool) => tool.id === id)),
    });
  const patch = (index: number, value: Partial<Tool>) =>
    setTools(
      config.tools.map((tool, current) => (current === index ? { ...tool, ...value } : tool)),
    );
  return (
    <Panel labelledBy="tools-config-title">
      <PanelHeader
        id="tools-config-title"
        title="Tool definitions"
        badge={
          <StatusBadge tone={config.tools.length ? 'soft' : 'warning'}>
            {config.tools.length} configured
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <div className="muted">
          HTTP endpoints and credential references are validated and invoked server-side. This
          editor never sends a credential value to a tool.
        </div>
        {!config.tools.length && (
          <EmptyState title="No tools configured">
            Add an HTTP or approved MCP tool. Discovery alone does not enable it.
          </EmptyState>
        )}
        {config.tools.map((tool, index) => (
          <ToolRow
            key={rowKeys.keyAt(index)}
            tool={tool}
            index={index}
            config={config}
            update={update}
            patch={patch}
            emptyTool={emptyTool}
            onRemove={() => {
              rowKeys.remove(index);
              setTools(config.tools.filter((_, current) => current !== index));
            }}
          />
        ))}
        <button
          className="button align-start"
          type="button"
          onClick={() => {
            rowKeys.insert(config.tools.length);
            setTools([...config.tools, emptyTool()]);
          }}
        >
          Add tool
        </button>
      </div>
    </Panel>
  );
}
