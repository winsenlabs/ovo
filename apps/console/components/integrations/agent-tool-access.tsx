'use client';
import type {
  AgentDraft,
  DiscoveredTool,
  McpConnection,
  SessionIdentity,
  ToolApproval,
} from '../../lib/api';
import { SectionCard } from '../ui/section-card';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { EmptyStateV2, InlineAlert, Skeleton } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { CodeBlock } from '../ui/code-block';
import { hasDrifted } from './mcp-helpers';

function ToolCard({
  tool,
  approved,
  drift,
  role,
  busy,
  onApprove,
  onRevoke,
}: {
  tool: DiscoveredTool;
  approved?: ToolApproval;
  drift: boolean;
  role: SessionIdentity['role'];
  busy?: boolean;
  onApprove: () => void;
  onRevoke?: () => void;
}) {
  return (
    <article className="tool-card">
      <div>
        <h3>{tool.remoteName}</h3>
        <p>{tool.description || 'No description returned by the remote server.'}</p>
      </div>
      <div className="tool-meta">
        <StatusBadgeV2
          tone={tool.effect === 'write' ? 'warn' : 'ok'}
          value={tool.effect ?? 'read'}
        />
        <span className="mono muted">schema {tool.schemaDigest}</span>
      </div>
      {drift && (
        <InlineAlert tone="danger">
          The discovered schema no longer matches the approved one. Review and re-approve before
          this tool can be used.
        </InlineAlert>
      )}
      <CodeBlock
        code={() => JSON.stringify(tool.inputSchema, null, 2)}
        collapsedLabel="Show input schema"
      />
      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={Boolean(approved && !drift) || role === 'viewer' || busy}
          onClick={onApprove}
        >
          {drift
            ? 'Review and re-approve'
            : approved
              ? 'Approved for this agent'
              : 'Approve for this agent'}
        </button>
        {approved && onRevoke && (
          <button
            type="button"
            className="button danger"
            disabled={role === 'viewer' || busy}
            onClick={onRevoke}
          >
            Revoke
          </button>
        )}
      </div>
    </article>
  );
}

export function AgentToolAccess({
  connections,
  selectedConnectionId,
  onSelectConnection,
  agents,
  selectedAgentId,
  onSelectAgent,
  discovered,
  discoveryLoading,
  approvals,
  approvalsLoading,
  approvalsError,
  role,
  busyToolId,
  onApprove,
  onRevoke,
}: {
  connections: McpConnection[];
  selectedConnectionId?: string;
  onSelectConnection: (id: string) => void;
  agents: AgentDraft[];
  selectedAgentId?: string;
  onSelectAgent: (id: string) => void;
  discovered: DiscoveredTool[];
  discoveryLoading: boolean;
  approvals: ToolApproval[];
  approvalsLoading: boolean;
  approvalsError?: string;
  role: SessionIdentity['role'];
  busyToolId?: string;
  onApprove: (tool: DiscoveredTool) => void;
  onRevoke: (approval: ToolApproval) => void;
}) {
  // Only approvals that belong to the *selected* connection can be "missing from discovery" —
  // an approval from a different connection is correctly absent from this one's discovered list
  // and should not be counted here.
  const approvedWithoutDiscovery = approvals.filter(
    (approval) =>
      approval.connectionId === selectedConnectionId &&
      !discovered.some((tool) => tool.id === (approval.toolId ?? approval.id)),
  );
  return (
    <SectionCard
      id="agent-tool-access"
      title="Agent tool access"
      description="Every tool is default-deny. Discovering a connection's tools grants nothing by itself — each one is approved per agent, and a schema change blocks re-use until it is reviewed."
    >
      <div className="form-grid">
        <FormField id="access-connection" label="Connection">
          {(props) => (
            <Select
              {...props}
              value={selectedConnectionId ?? ''}
              onChange={onSelectConnection}
              placeholder="No connection"
              options={connections.map((item) => ({ value: item.id, label: item.label }))}
            />
          )}
        </FormField>
        <FormField id="access-agent" label="Agent approval scope">
          {(props) => (
            <Select
              {...props}
              value={selectedAgentId ?? ''}
              onChange={onSelectAgent}
              placeholder="No agent"
              options={agents.map((item) => ({ value: item.id, label: item.config.name }))}
            />
          )}
        </FormField>
      </div>
      {approvalsError && <InlineAlert tone="warn">{approvalsError}</InlineAlert>}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 'var(--space-6, 24px)',
          // `.stack` is a bare grid with no explicit row sizing, so without these two the taller
          // column stretches the shorter one's rows to match and both columns drift apart.
          alignItems: 'start',
          marginTop: 'var(--space-5, 20px)',
        }}
      >
        <div className="stack" style={{ alignContent: 'start' }}>
          <h3>Discovered tools</h3>
          {discoveryLoading ? (
            <Skeleton shape="block" />
          ) : !connections.length ? (
            <EmptyStateV2 title="No connections yet">
              Add an MCP connection above to discover its tools.
            </EmptyStateV2>
          ) : !selectedConnectionId ? (
            <EmptyStateV2 title="Select a connection">
              Discovered tools for that connection will appear here.
            </EmptyStateV2>
          ) : !discovered.length ? (
            <EmptyStateV2 title="No discovered tools yet">
              Use Discover on that connection above. This empty state grants no access.
            </EmptyStateV2>
          ) : (
            discovered.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                approved={approvals.find(
                  (approval) => (approval.toolId ?? approval.id) === tool.id,
                )}
                drift={hasDrifted(tool, approvals)}
                role={role}
                busy={busyToolId !== undefined && busyToolId === tool.id}
                onApprove={() => onApprove(tool)}
                onRevoke={() =>
                  onRevoke(
                    approvals.find((approval) => (approval.toolId ?? approval.id) === tool.id)!,
                  )
                }
              />
            ))
          )}
        </div>
        <div className="stack" style={{ alignContent: 'start' }}>
          <h3>Approved for this agent</h3>
          {approvalsLoading ? (
            <Skeleton shape="block" />
          ) : !agents.length ? (
            <EmptyStateV2 title="No agents yet">
              Create an agent to approve tools for it.
            </EmptyStateV2>
          ) : !selectedAgentId ? (
            <EmptyStateV2 title="Select an agent">
              Its approved tools will appear here.
            </EmptyStateV2>
          ) : !approvals.length ? (
            <EmptyStateV2 title="No tools approved yet">
              Approve a discovered tool on the left.
            </EmptyStateV2>
          ) : (
            approvals.map((approval) => {
              const key = approval.toolId ?? approval.id ?? approval.remoteName;
              const tool = discovered.find((item) => item.id === key);
              const drift = tool ? tool.schemaDigest !== approval.schemaDigest : false;
              return (
                <article className="tool-card" key={key}>
                  <div>
                    <h3>{approval.remoteName}</h3>
                    <p className="muted">
                      via{' '}
                      {connections.find((c) => c.id === approval.connectionId)?.label ??
                        approval.connectionId}
                    </p>
                  </div>
                  <div className="tool-meta">
                    <StatusBadgeV2
                      tone={approval.effect === 'write' ? 'warn' : 'ok'}
                      value={approval.effect ?? 'read'}
                    />
                    <span className="mono muted">schema {approval.schemaDigest}</span>
                  </div>
                  {drift && (
                    <InlineAlert tone="danger">
                      Discovery reports a newer schema for this tool.
                    </InlineAlert>
                  )}
                  <div className="button-row">
                    <button
                      type="button"
                      className="button danger"
                      disabled={role === 'viewer' || busyToolId === key}
                      onClick={() => onRevoke(approval)}
                    >
                      Revoke
                    </button>
                  </div>
                </article>
              );
            })
          )}
          {approvedWithoutDiscovery.length > 0 && (
            <InlineAlert tone="info">
              {approvedWithoutDiscovery.length === 1
                ? '1 approval references a tool'
                : `${approvedWithoutDiscovery.length} approvals reference a tool`}{' '}
              not in this connection's current discovery.
            </InlineAlert>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
