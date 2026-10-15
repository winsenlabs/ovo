import { useState } from 'react';
import { useConfirm } from '../ui/dialog';
import {
  apiRequest,
  ifMatch,
  type AgentDraft,
  type DiscoveredTool,
  type McpConnection,
  type ToolApproval,
} from '../../lib/api';
import { bindDiscoveredMcpTool } from './mcp-agent-config';
import type { ToolsMessage } from './use-connection-actions';
import type { ApprovalsState } from './use-mcp-connections';

/** Approve/revoke a discovered tool for one agent — the write half of the default-deny review
 * panel (brief §3 Tools: "Discovery alone grants no access"). */
export function useToolApprovals({
  agent,
  connection,
  setApprovals,
  setMessage,
  reload,
}: {
  agent?: AgentDraft;
  connection?: McpConnection;
  setApprovals: (updater: (current: ApprovalsState) => ApprovalsState) => void;
  setMessage: (message: ToolsMessage) => void;
  reload: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [busyToolId, setBusyToolId] = useState<string>();

  async function approve(tool: DiscoveredTool) {
    if (!agent || !connection) return;
    setBusyToolId(tool.id);
    try {
      await apiRequest(`/agents/${agent.id}/mcp-tools/${encodeURIComponent(tool.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          connectionId: connection.id,
          remoteName: tool.remoteName,
          schemaDigest: tool.schemaDigest,
        }),
      });
      setApprovals((current) => ({
        status: 'ready',
        data: [
          ...current.data.filter((approval) => (approval.toolId ?? approval.id) !== tool.id),
          {
            toolId: tool.id,
            connectionId: connection.id,
            remoteName: tool.remoteName,
            schemaDigest: tool.schemaDigest,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            effect: tool.effect,
          },
        ],
      }));
      try {
        const nextConfig = bindDiscoveredMcpTool(agent.config, connection, tool);
        await apiRequest(`/agents/${agent.id}`, {
          method: 'PUT',
          headers: { 'if-match': ifMatch(agent.draftVersion) },
          body: JSON.stringify({ config: nextConfig }),
        });
        // Refresh the agent draft (version/etag + config) so a second approval in the same
        // session sends a current if-match instead of replaying this one's now-stale version.
        await reload();
      } catch (error) {
        setMessage({
          tone: 'warn',
          text: `Approved, but the agent draft could not be updated: ${
            error instanceof Error ? error.message : 'draft update failed'
          }. Resolve the draft before publishing.`,
        });
        return;
      }
      setMessage({
        tone: 'info',
        text: `${tool.remoteName} explicitly approved for ${agent.config.name}.`,
      });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'Tool approval failed.',
      });
    } finally {
      setBusyToolId(undefined);
    }
  }

  async function revoke(approval: ToolApproval) {
    if (!agent) return;
    const toolId = approval.toolId ?? approval.id ?? approval.remoteName;
    if (
      !(await confirm(
        'Revoke tool',
        `Revoke ${agent.config.name}'s access to ${approval.remoteName}?`,
      ))
    )
      return;
    setBusyToolId(toolId);
    try {
      await apiRequest(`/agents/${agent.id}/mcp-tools/${encodeURIComponent(toolId)}`, {
        method: 'DELETE',
      });
      setApprovals((current) => ({
        status: 'ready',
        data: current.data.filter((item) => (item.toolId ?? item.id) !== toolId),
      }));
      setMessage({
        tone: 'info',
        text: `${approval.remoteName} revoked for ${agent.config.name}.`,
      });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'Revoke failed.',
      });
    } finally {
      setBusyToolId(undefined);
    }
  }

  return { busyToolId, approve, revoke };
}
