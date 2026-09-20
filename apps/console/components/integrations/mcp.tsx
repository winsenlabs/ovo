'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  apiRequest,
  ApiError,
  ifMatch,
  items,
  type AgentDraft,
  type CredentialMetadata,
  type DiscoveredTool,
  type McpConnection,
  type SessionIdentity,
  type ToolApproval,
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
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
export function McpManager({
  connections,
  credentials,
  agents,
  reload,
  role,
}: {
  connections: McpConnection[];
  credentials: CredentialMetadata[];
  agents: AgentDraft[];
  reload: () => Promise<void>;
  role: SessionIdentity['role'];
}) {
  const [selectedConnection, setSelectedConnection] = useState<string>();
  const [selectedAgent, setSelectedAgent] = useState<string>();
  const [discoveries, setDiscoveries] = useState<Record<string, DiscoveredTool[]>>({});
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [message, setMessage] = useState<{
    tone: 'neutral' | 'danger' | 'warning';
    text: string;
  }>();
  const connection = connections.find((item) => item.id === selectedConnection) ?? connections[0];
  const agent = agents.find((item) => item.id === selectedAgent) ?? agents[0];
  useEffect(() => {
    if (!selectedConnection && connections[0]) setSelectedConnection(connections[0].id);
  }, [connections, selectedConnection]);
  useEffect(() => {
    if (!selectedAgent && agents[0]) setSelectedAgent(agents[0].id);
  }, [agents, selectedAgent]);
  useEffect(() => {
    if (!agent) {
      setApprovals([]);
      return;
    }
    apiRequest<unknown>(`/agents/${agent.id}/mcp-tools`)
      .then(({ data }) => setApprovals(items<ToolApproval>(data)))
      .catch((error) =>
        setMessage({
          tone: error instanceof ApiError && error.status === 403 ? 'warning' : 'danger',
          text: safeMessage(error, 'Tool approvals unavailable.'),
        }),
      );
  }, [agent?.id]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setMessage(undefined);
    try {
      await apiRequest('/mcp-connections', {
        method: 'POST',
        body: JSON.stringify({
          label: values.get('label'),
          endpoint: values.get('endpoint'),
          auth: values.get('auth'),
          credentialId: values.get('credentialId') || undefined,
        }),
      });
      form.reset();
      await reload();
    } catch (error) {
      setMessage({ tone: 'danger', text: safeMessage(error, 'MCP connection creation failed.') });
    }
  }

  async function connectionAction(action: 'test' | 'discover') {
    if (!connection) return;
    setMessage(undefined);
    try {
      const { data } = await apiRequest<unknown>(`/mcp-connections/${connection.id}/${action}`, {
        method: 'POST',
      });
      if (action === 'discover') {
        const discovered = items<Omit<DiscoveredTool, 'id'>>(data).map((tool) => ({
          ...tool,
          id: tool.remoteName,
        }));
        setDiscoveries((current) => ({ ...current, [connection.id]: discovered }));
        setMessage({
          tone: 'neutral',
          text: `${discovered.length} tools discovered. None were approved automatically.`,
        });
      } else
        setMessage({
          tone: 'neutral',
          text: 'The server-side connection test completed. Review its bounded result below.',
        });
      if (action === 'test')
        setMessage({ tone: 'neutral', text: `Connection test result: ${JSON.stringify(data)}` });
    } catch (error) {
      const unavailable = error instanceof ApiError && error.status === 404;
      setMessage({
        tone: unavailable ? 'warning' : 'danger',
        text: unavailable
          ? `The current management API does not expose the MCP ${action} operation. No result was fabricated.`
          : safeMessage(error, `${action} failed.`),
      });
    }
  }

  async function approve(tool: DiscoveredTool) {
    if (!agent || !connection) return;
    setMessage(undefined);
    try {
      await apiRequest(`/agents/${agent.id}/mcp-tools/${encodeURIComponent(tool.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          connectionId: connection.id,
          remoteName: tool.remoteName,
          schemaDigest: tool.schemaDigest,
        }),
      });
      const current = approvals.find((approval) => (approval.toolId ?? approval.id) === tool.id);
      setApprovals((all) => [
        ...all.filter((approval) => (approval.toolId ?? approval.id) !== tool.id),
        {
          toolId: tool.id,
          connectionId: connection.id,
          remoteName: tool.remoteName,
          schemaDigest: tool.schemaDigest,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          effect: tool.effect,
        },
      ]);
      if (!agent.config.allowedTools.includes(tool.id)) {
        const nextConfig = {
          ...agent.config,
          allowedTools: [...agent.config.allowedTools, tool.id],
        };
        try {
          await apiRequest(`/agents/${agent.id}`, {
            method: 'PUT',
            headers: { 'if-match': ifMatch(agent.draftVersion) },
            body: JSON.stringify({ config: nextConfig }),
          });
        } catch (error) {
          setMessage({
            tone: 'warning',
            text: `The approval was stored, but the agent draft allowlist was not updated: ${safeMessage(error, 'draft update failed')}. Resolve the draft before publishing.`,
          });
          return;
        }
      }
      setMessage({
        tone: 'neutral',
        text: `${tool.remoteName} explicitly approved for ${agent.config.name}. Discovery alone granted nothing.`,
      });
    } catch (error) {
      setMessage({ tone: 'danger', text: safeMessage(error, 'Tool approval failed.') });
    }
  }

  const discovered = connection ? (discoveries[connection.id] ?? []) : [];
  const drifted = useMemo(
    () =>
      discovered.filter((tool) => {
        const approved = approvals.find((item) => (item.toolId ?? item.id) === tool.id);
        return approved && approved.schemaDigest !== tool.schemaDigest;
      }),
    [approvals, discovered],
  );
  return (
    <div className="stack">
      <Panel labelledBy="mcp-create-title">
        <PanelHeader
          id="mcp-create-title"
          title="Remote MCP connection"
          badge={<StatusBadge tone="soft">Server-side auth</StatusBadge>}
        />
        <form className="panel-body stack" onSubmit={create}>
          <div className="form-grid">
            <Field label="Connection label" htmlFor="mcp-label">
              <input id="mcp-label" name="label" required />
            </Field>
            <Field
              label="Remote HTTP endpoint"
              htmlFor="mcp-endpoint"
              help="Arbitrary browser-entered shell commands are not supported."
            >
              <input id="mcp-endpoint" name="endpoint" type="url" required />
            </Field>
            <Field label="Authentication" htmlFor="mcp-auth">
              <select id="mcp-auth" name="auth">
                <option value="none">None</option>
                <option value="bearer">Bearer credential</option>
              </select>
            </Field>
            <Field label="Credential reference" htmlFor="mcp-credential">
              <select id="mcp-credential" name="credentialId">
                <option value="">No credential</option>
                {credentials
                  .filter((item) => item.type === 'tool')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <button className="button align-start" disabled={role === 'viewer'}>
            Create connection
          </button>
        </form>
      </Panel>
      {message && (
        <Notice tone={message.tone} live>
          {message.text}
        </Notice>
      )}
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
    </div>
  );
}
