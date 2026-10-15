import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiRequest,
  ApiError,
  items,
  type AgentDraft,
  type CredentialMetadata,
  type DiscoveredTool,
  type McpConnection,
  type ToolApproval,
} from '../../lib/api';
import { loadNormalizedAgents, settleList, type Loaded } from './settings-data';

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Approvals carry a fourth status: a 403 means the viewer's role cannot see them at all, which
 * is not the same thing as the API being down. */
export type ApprovalsState = {
  status: 'loading' | 'ready' | 'error' | 'denied';
  data: ToolApproval[];
  error?: string;
};

/**
 * Data loading for the Tools settings screen: connections/credentials/agents, the persisted
 * discovery for whichever connection is selected (`GET /mcp-connections/:id/tools`, which the
 * review panel used to leave unread — every session had to re-click Discover to see anything),
 * and the approvals for whichever agent is selected.
 */
export function useMcpConnections() {
  const [connections, setConnections] = useState<Loaded<McpConnection[]>>({
    status: 'loading',
    data: [],
  });
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const loaded = useRef(false);

  const reload = useCallback(async () => {
    if (!loaded.current) setConnections((current) => ({ ...current, status: 'loading' }));
    const [connectionResult, credentialResult, agentResult] = await Promise.allSettled([
      apiRequest<unknown>('/mcp-connections'),
      apiRequest<unknown>('/credentials'),
      loadNormalizedAgents(),
    ]);
    setConnections(settleList(connectionResult, 'MCP connections unavailable.'));
    if (credentialResult.status === 'fulfilled') setCredentials(items(credentialResult.value.data));
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value);
    loaded.current = true;
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  useEffect(() => {
    if (!selectedConnectionId && connections.data[0])
      setSelectedConnectionId(connections.data[0].id);
  }, [connections.data, selectedConnectionId]);
  useEffect(() => {
    if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId]);
  const connection = connections.data.find((item) => item.id === selectedConnectionId);
  const agent = agents.find((item) => item.id === selectedAgentId);

  const [discoveries, setDiscoveries] = useState<Record<string, DiscoveredTool[]>>({});
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const connectionId = connection?.id;
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    setDiscoveryLoading(true);
    apiRequest<unknown>(`/mcp-connections/${connectionId}/tools`)
      .then(({ data }) => {
        if (!cancelled)
          setDiscoveries((current) => ({
            ...current,
            // The persisted projection for some backends (postgres, sqlite) omits `id` from
            // `mapDiscovered`; fall back to `remoteName`, the same stable key `discoverConnection`
            // assigns, so a tool approved before a reload keeps the same identity.
            [connectionId]: items<DiscoveredTool>(data).map((tool) => ({
              ...tool,
              id: tool.id ?? tool.remoteName,
            })),
          }));
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setDiscoveryLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const [approvals, setApprovals] = useState<ApprovalsState>({ status: 'loading', data: [] });
  useEffect(() => {
    if (!agent) {
      // No agent to scope approvals to. `connections.status` leaving 'loading' is this hook's
      // signal that the initial `reload()` has settled (empty fixture, or a 503 that
      // `loadNormalizedAgents` already turned into `[]`) — only then do we know "no agent" is
      // final rather than "not fetched yet", so only then do we stop the skeleton that nothing
      // would otherwise ever resolve.
      if (connections.status !== 'loading') setApprovals({ status: 'ready', data: [] });
      return;
    }
    let cancelled = false;
    setApprovals((current) => ({ ...current, status: 'loading' }));
    apiRequest<unknown>(`/agents/${agent.id}/mcp-tools`)
      .then(({ data }) => !cancelled && setApprovals({ status: 'ready', data: items(data) }))
      .catch((error) => {
        if (cancelled) return;
        const denied = error instanceof ApiError && error.status === 403;
        setApprovals({
          status: denied ? 'denied' : 'error',
          data: [],
          error: safeMessage(error, 'Tool approvals unavailable.'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [agent, connections.status]);

  return {
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
  };
}
