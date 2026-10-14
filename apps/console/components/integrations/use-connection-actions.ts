import { useState } from 'react';
import { useConfirm } from '../ui/dialog';
import {
  apiRequest,
  ApiError,
  items,
  type DiscoveredTool,
  type McpConnection,
} from '../../lib/api';

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export type ToolsMessage = { tone: 'info' | 'danger' | 'warn'; text: string };
export type ConnectionPayload = {
  label: string;
  endpoint: string;
  auth: 'none' | 'bearer';
  credentialId?: string;
};

/** Create/edit/delete/test/discover for MCP connections, lifted out of `tools-settings.tsx` to
 * keep that module under the §13.1 line gate. */
export function useConnectionActions({
  reload,
  setDiscoveries,
  onDeleted,
}: {
  reload: () => Promise<void>;
  setDiscoveries: (
    updater: (current: Record<string, DiscoveredTool[]>) => Record<string, DiscoveredTool[]>,
  ) => void;
  onDeleted: (connectionId: string) => void;
}) {
  const confirm = useConfirm();
  const [message, setMessage] = useState<ToolsMessage>();
  const [busyConnectionId, setBusyConnectionId] = useState<string>();
  const [drawer, setDrawer] = useState<{ open: boolean; connection?: McpConnection }>({
    open: false,
  });

  async function saveConnection(payload: ConnectionPayload) {
    setBusyConnectionId('drawer');
    try {
      const editing = drawer.connection;
      await apiRequest(editing ? `/mcp-connections/${editing.id}` : '/mcp-connections', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      setDrawer({ open: false });
      await reload();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: safeMessage(error, 'MCP connection could not be saved.'),
      });
    } finally {
      setBusyConnectionId(undefined);
    }
  }

  async function removeConnection(target: McpConnection) {
    if (
      !(await confirm(
        'Delete connection',
        `Delete "${target.label}"? Agents can no longer discover or call its tools.`,
      ))
    )
      return;
    setBusyConnectionId(target.id);
    try {
      await apiRequest(`/mcp-connections/${target.id}`, { method: 'DELETE' });
      onDeleted(target.id);
      await reload();
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: safeMessage(error, 'MCP connection could not be deleted.'),
      });
    } finally {
      setBusyConnectionId(undefined);
    }
  }

  async function testConnection(target: McpConnection) {
    setBusyConnectionId(target.id);
    setMessage(undefined);
    try {
      await apiRequest<unknown>(`/mcp-connections/${target.id}/test`, { method: 'POST' });
      setMessage({ tone: 'info', text: `${target.label}: connection test passed.` });
      await reload();
    } catch (error) {
      const unavailable = error instanceof ApiError && error.status === 404;
      setMessage({
        tone: unavailable ? 'warn' : 'danger',
        text: unavailable
          ? 'The current management API does not expose the MCP test operation.'
          : safeMessage(error, 'Connection test failed.'),
      });
    } finally {
      setBusyConnectionId(undefined);
    }
  }

  async function discoverConnection(target: McpConnection) {
    setBusyConnectionId(target.id);
    setMessage(undefined);
    try {
      const { data } = await apiRequest<unknown>(`/mcp-connections/${target.id}/discover`, {
        method: 'POST',
      });
      const discovered = items<Omit<DiscoveredTool, 'id'>>(data).map((tool) => ({
        ...tool,
        id: tool.remoteName,
      }));
      setDiscoveries((current) => ({ ...current, [target.id]: discovered }));
      setMessage({
        tone: 'info',
        text: `${discovered.length} tool${discovered.length === 1 ? '' : 's'} discovered. None were approved automatically.`,
      });
      await reload();
    } catch (error) {
      const unavailable = error instanceof ApiError && error.status === 404;
      setMessage({
        tone: unavailable ? 'warn' : 'danger',
        text: unavailable
          ? 'The current management API does not expose the MCP discover operation.'
          : safeMessage(error, 'Discovery failed.'),
      });
    } finally {
      setBusyConnectionId(undefined);
    }
  }

  return {
    message,
    setMessage,
    busyConnectionId,
    drawer,
    setDrawer,
    saveConnection,
    removeConnection,
    testConnection,
    discoverConnection,
  };
}
