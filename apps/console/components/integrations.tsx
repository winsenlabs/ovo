'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiRequest,
  ApiError,
  items,
  normalizeDraft,
  type AgentDraft,
  type CredentialMetadata,
  type McpConnection,
  type ProviderBinding,
  type SessionIdentity,
} from '../lib/api';
import { LoadingBlock } from './primitives';
import { CredentialManager } from './integrations/credentials';
import { BindingManager } from './integrations/bindings';
import { McpManager } from './integrations/mcp';
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
export function Integrations({
  initialTab,
  identity,
}: {
  initialTab: string;
  identity: SessionIdentity;
}) {
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [bindings, setBindings] = useState<ProviderBinding[]>([]);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const loaded = useRef(false);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    if (!loaded.current) setLoading(true);
    setError(undefined);
    const results = await Promise.allSettled([
      apiRequest<unknown>('/credentials'),
      apiRequest<unknown>('/provider-bindings'),
      apiRequest<unknown>('/mcp-connections'),
      apiRequest<unknown>('/agents'),
    ]);
    const [credentialResult, bindingResult, connectionResult, agentResult] = results;
    if (credentialResult.status === 'fulfilled') setCredentials(items(credentialResult.value.data));
    else if (!(
      credentialResult.reason instanceof ApiError && credentialResult.reason.status === 403
    ))
      setError(safeMessage(credentialResult.reason, 'Credentials unavailable.'));
    if (bindingResult.status === 'fulfilled') setBindings(items(bindingResult.value.data));
    if (connectionResult.status === 'fulfilled') setConnections(items(connectionResult.value.data));
    if (agentResult.status === 'fulfilled')
      setAgents(
        items<Record<string, unknown>>(agentResult.value.data)
          .filter((value) => value.config)
          .map((value) => normalizeDraft(value)),
      );
    loaded.current = true;
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (loading) return <LoadingBlock label="Loading integration metadata" />;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Integrations</p>
          <h1>{initialTab === 'tools' ? 'Tools and MCP' : 'Providers & secrets'}</h1>
          <p className="muted">
            Credentials stay server-side. Discovery never grants agent access.
          </p>
        </div>
      </header>
      {error && <div className="field-error" role="alert">{error}</div>}
      {initialTab === 'providers' ? (
        <div className="stack">
          <CredentialManager
            credentials={credentials}
            agents={agents}
            reload={reload}
            role={identity.role}
          />
          <BindingManager
            bindings={bindings}
            credentials={credentials}
            reload={reload}
            role={identity.role}
          />
        </div>
      ) : (
        <McpManager
          connections={connections}
          credentials={credentials}
          agents={agents}
          reload={reload}
          role={identity.role}
        />
      )}
    </>
  );
}
