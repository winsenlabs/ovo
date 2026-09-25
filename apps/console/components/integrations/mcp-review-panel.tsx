'use client';
import type { Dispatch, SetStateAction } from 'react';
import type {
  AgentDraft,
  DiscoveredTool,
  McpConnection,
  SessionIdentity,
  ToolApproval,
} from '../../lib/api';
import {
  EmptyState,
  Field,
  JsonEvidence,
  Notice,
  Panel,
  PanelHeader,
  StatusBadge,
} from '../primitives';
export function McpReviewPanel({
  drifted,
  connection,
  connections,
  setSelectedConnection,
  agent,
  agents,
  setSelectedAgent,
  role,
  connectionAction,
  discovered,
  approvals,
  approve,
}: {
  drifted: DiscoveredTool[];
  connection?: McpConnection;
  connections: McpConnection[];
  setSelectedConnection: Dispatch<SetStateAction<string | undefined>>;
  agent?: AgentDraft;
  agents: AgentDraft[];
  setSelectedAgent: Dispatch<SetStateAction<string | undefined>>;
  role: SessionIdentity['role'];
  connectionAction: (action: 'test' | 'discover') => Promise<void>;
  discovered: DiscoveredTool[];
  approvals: ToolApproval[];
  approve: (tool: DiscoveredTool) => Promise<void>;
}) {
  return (
    <Panel labelledBy="mcp-review-title">
      <PanelHeader
        id="mcp-review-title"
        title="Discovery and per-agent approval"
        badge={
          <StatusBadge tone={drifted.length ? 'danger' : 'warning'}>
            {drifted.length ? `${drifted.length} schema changes` : 'Default deny'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <div className="form-grid">
          <Field label="Connection" htmlFor="selected-connection">
            <select
              id="selected-connection"
              value={connection?.id ?? ''}
              onChange={(event) => setSelectedConnection(event.target.value)}
            >
              <option value="">No connection</option>
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent approval scope" htmlFor="selected-agent">
            <select
              id="selected-agent"
              value={agent?.id ?? ''}
              onChange={(event) => setSelectedAgent(event.target.value)}
            >
              <option value="">No agent</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.config.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="button-row">
          <button
            className="button"
            disabled={!connection || role === 'viewer'}
            onClick={() => connectionAction('test')}
          >
            Test connection
          </button>
          <button
            className="button primary"
            disabled={!connection || role === 'viewer'}
            onClick={() => connectionAction('discover')}
          >
            Discover tools
          </button>
        </div>
        {drifted.length > 0 && (
          <Notice tone="danger">
            A discovered schema digest differs from the stored approval. Publication must remain
            blocked until each changed schema is reviewed and re-approved.
          </Notice>
        )}
        {discovered.length === 0 ? (
          <EmptyState title="No discovered tools loaded">
            Run discovery against an API connection. This empty state grants no access.
          </EmptyState>
        ) : (
          discovered.map((tool) => {
            const approved = approvals.find((item) => (item.toolId ?? item.id) === tool.id);
            const drift = approved && approved.schemaDigest !== tool.schemaDigest;
            return (
              <article className="tool-card" key={tool.id}>
                <div>
                  <h3>{tool.remoteName}</h3>
                  <p>{tool.description ?? 'No description returned by the remote server.'}</p>
                </div>
                <div className="tool-meta">
                  <StatusBadge tone={tool.effect === 'write' ? 'warning' : 'soft'}>
                    {tool.effect ?? 'Effect not classified'}
                  </StatusBadge>
                  <span className="mono">schema {tool.schemaDigest}</span>
                </div>
                <JsonEvidence label="Inspect input schema" value={tool.inputSchema} />
                {tool.outputSchema && (
                  <JsonEvidence label="Inspect output schema" value={tool.outputSchema} />
                )}
                <button
                  className="button"
                  disabled={Boolean(approved && !drift) || role === 'viewer'}
                  onClick={() => approve(tool)}
                >
                  {drift
                    ? 'Review and re-approve schema'
                    : approved
                      ? 'Approved for this agent'
                      : 'Approve for this agent'}
                </button>
              </article>
            );
          })
        )}
      </div>
    </Panel>
  );
}
