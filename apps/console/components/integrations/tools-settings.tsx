'use client';
import type { SessionIdentity } from '../../lib/api';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { InlineAlert, ErrorState } from '../ui/feedback-v2';
import { connectionHealthCounts } from './mcp-helpers';
import { useMcpConnections } from './use-mcp-connections';
import { useConnectionActions } from './use-connection-actions';
import { useToolApprovals } from './use-tool-approvals';
import { ConnectionsTable } from './connections-table';
import { ConnectionDrawer } from './connection-drawer';
import { AgentToolAccess } from './agent-tool-access';

export function ToolsSettings({ identity }: { identity: SessionIdentity }) {
  const {
    connections,
    credentials,
    agents,
    reload,
    connection,
    selectedConnectionId,
    setSelectedConnectionId,
    agent,
    selectedAgentId,
    setSelectedAgentId,
    discoveries,
    setDiscoveries,
    discoveryLoading,
    approvals,
    setApprovals,
  } = useMcpConnections();

  const {
    message,
    setMessage,
    busyConnectionId,
    drawer,
    setDrawer,
    saveConnection,
    removeConnection,
    testConnection,
    discoverConnection,
  } = useConnectionActions({
    reload,
    setDiscoveries,
    onDeleted: (id) => {
      if (selectedConnectionId === id) setSelectedConnectionId(undefined);
    },
  });
  const { busyToolId, approve, revoke } = useToolApprovals({
    agent,
    connection,
    setApprovals,
    setMessage,
  });
  const health = connectionHealthCounts(connections.data);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Tools"
        description="Connect a remote MCP server, then review and approve its tools per agent. Discovery alone grants no access."
        actions={
          <button
            type="button"
            className="button primary"
            disabled={identity.role === 'viewer'}
            onClick={() => setDrawer({ open: true })}
          >
            Add MCP connection
          </button>
        }
      />
      <KpiStrip>
        <KpiCard
          label="Connections"
          value={connections.status === 'error' ? null : connections.data.length}
          loading={connections.status === 'loading'}
        />
        <KpiCard
          label="Healthy"
          value={connections.status === 'error' ? null : health.ok}
          loading={connections.status === 'loading'}
        />
        <KpiCard
          label="Needs attention"
          value={connections.status === 'error' ? null : health.attention}
          loading={connections.status === 'loading'}
          delta={
            connections.status !== 'error' && health.attention > 0
              ? { value: health.attention, tone: 'danger', label: 'failing' }
              : undefined
          }
        />
        <KpiCard
          label="Approved for selected agent"
          value={approvals.status === 'ready' ? approvals.data.length : undefined}
          loading={approvals.status === 'loading'}
        />
      </KpiStrip>
      {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
      <SectionCard id="connections" title="Connections" padding="flush">
        {connections.status === 'error' ? (
          <div style={{ padding: 'var(--space-5)' }}>
            <ErrorState
              message={connections.error ?? 'MCP connections unavailable.'}
              onRetry={reload}
            />
          </div>
        ) : (
          <ConnectionsTable
            connections={connections.data}
            loading={connections.status === 'loading'}
            busyId={busyConnectionId}
            role={identity.role}
            onTest={(c) => void testConnection(c)}
            onDiscover={(c) => void discoverConnection(c)}
            onEdit={(c) => setDrawer({ open: true, connection: c })}
            onRemove={(c) => void removeConnection(c)}
            onAdd={() => setDrawer({ open: true })}
          />
        )}
      </SectionCard>
      <AgentToolAccess
        connections={connections.data}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
        discovered={connection ? (discoveries[connection.id] ?? []) : []}
        discoveryLoading={discoveryLoading}
        approvals={approvals.status === 'ready' ? approvals.data : []}
        approvalsLoading={approvals.status === 'loading'}
        approvalsError={
          approvals.status === 'error'
            ? approvals.error
            : approvals.status === 'denied'
              ? "Your role can't view tool approvals."
              : undefined
        }
        role={identity.role}
        busyToolId={busyToolId}
        onApprove={(tool) => void approve(tool)}
        onRevoke={(approval) => void revoke(approval)}
      />
      <ConnectionDrawer
        open={drawer.open}
        connection={drawer.connection}
        credentials={credentials}
        busy={busyConnectionId === 'drawer'}
        onClose={() => setDrawer({ open: false })}
        onSubmit={saveConnection}
      />
    </>
  );
}
