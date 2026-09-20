import type { AgentConfig, OperationStore } from '@winsendotai/ovo-contracts';
import type {
  AgentDraft,
  AuditEntry,
  CallRecord,
  CredentialMetadata,
  CredentialReferences,
  EvaluationRecord,
  McpConnection,
  McpDiscoveredTool,
  McpToolApproval,
  Page,
  ProviderBinding,
  ReleaseRecord,
  SecretBlob,
  StoredCallEvent,
  UsageEntry,
} from './models.ts';

export interface ControlStore {
  readonly operationStore: OperationStore;
  ensureWorkspace(id: string, name?: string): Promise<void>;
  createAgent(workspaceId: string, config: AgentConfig, id?: string): Promise<AgentDraft>;
  getAgent(workspaceId: string, id: string): Promise<AgentDraft | undefined>;
  listAgents(workspaceId: string, limit?: number, cursor?: string): Promise<Page<AgentDraft>>;
  updateAgent(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    config: AgentConfig,
  ): Promise<AgentDraft>;
  deleteAgent(workspaceId: string, id: string, expectedVersion: number): Promise<void>;
  createRelease(input: {
    workspaceId: string;
    agent: AgentDraft;
    plugins: { id: string; version: string }[];
    createdBy: string;
    id?: string;
  }): Promise<ReleaseRecord>;
  getRelease(workspaceId: string, id: string): Promise<ReleaseRecord | undefined>;
  listReleases(
    workspaceId: string,
    agentId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<ReleaseRecord>>;
  createCredential(input: {
    workspaceId: string;
    label: string;
    provider: string;
    type: string;
    environment: string;
    backend: CredentialMetadata['backend'];
    permittedAgentIds: string[];
    expiresAt?: string | null;
    createdBy: string;
    fingerprint: string;
    secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;
    id?: string;
  }): Promise<CredentialMetadata>;
  rotateCredential(
    workspaceId: string,
    id: string,
    input: {
      fingerprint: string;
      secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;
    },
  ): Promise<CredentialMetadata>;
  getCredential(workspaceId: string, id: string): Promise<CredentialMetadata | undefined>;
  listCredentials(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<CredentialMetadata>>;
  getActiveSecretBlob(workspaceId: string, id: string): Promise<SecretBlob | undefined>;
  credentialReferences(
    workspaceId: string,
    id: string,
    maxIds?: number,
  ): Promise<CredentialReferences>;
  retireCredential(workspaceId: string, id: string): Promise<CredentialMetadata>;
  createProviderBinding(
    input: Omit<ProviderBinding, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<ProviderBinding>;
  getProviderBinding(workspaceId: string, id: string): Promise<ProviderBinding | undefined>;
  listProviderBindings(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<ProviderBinding>>;
  updateProviderBinding(
    workspaceId: string,
    id: string,
    input: {
      label: string;
      provider: string;
      environment: string;
      credentialId: string;
      config: Record<string, unknown>;
    },
  ): Promise<ProviderBinding>;
  deleteProviderBinding(workspaceId: string, id: string): Promise<void>;
  createMcpConnection(input: {
    workspaceId: string;
    label: string;
    endpoint: string;
    auth: 'none' | 'bearer';
    credentialId?: string | null;
    id?: string;
  }): Promise<McpConnection>;
  getMcpConnection(workspaceId: string, id: string): Promise<McpConnection | undefined>;
  listMcpConnections(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<McpConnection>>;
  updateMcpConnection(
    workspaceId: string,
    id: string,
    input: {
      label: string;
      endpoint: string;
      auth: 'none' | 'bearer';
      credentialId?: string | null;
    },
  ): Promise<McpConnection>;
  setMcpConnectionStatus(
    workspaceId: string,
    id: string,
    status: McpConnection['status'],
  ): Promise<McpConnection>;
  deleteMcpConnection(workspaceId: string, id: string): Promise<void>;
  replaceMcpDiscoveredTools(
    workspaceId: string,
    connectionId: string,
    tools: Omit<McpDiscoveredTool, 'connectionId' | 'discoveredAt'>[],
  ): Promise<McpDiscoveredTool[]>;
  getMcpDiscoveredTool(
    workspaceId: string,
    connectionId: string,
    remoteName: string,
  ): Promise<McpDiscoveredTool | undefined>;
  listMcpDiscoveredTools(
    workspaceId: string,
    connectionId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<McpDiscoveredTool>>;
  upsertMcpApproval(input: {
    workspaceId: string;
    agentId: string;
    toolId: string;
    connectionId: string;
    remoteName: string;
    schemaDigest: string;
  }): Promise<McpToolApproval>;
  getMcpApproval(
    workspaceId: string,
    agentId: string,
    toolId: string,
  ): Promise<McpToolApproval | undefined>;
  listMcpApprovals(
    workspaceId: string,
    agentId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<McpToolApproval>>;
  deleteMcpApproval(workspaceId: string, agentId: string, toolId: string): Promise<void>;
  createCall(input: {
    workspaceId: string;
    releaseId: string;
    kind: 'live' | 'simulation';
    status: string;
    id?: string;
  }): Promise<CallRecord>;
  getCall(workspaceId: string, id: string): Promise<CallRecord | undefined>;
  listCalls(workspaceId: string, limit?: number, cursor?: string): Promise<Page<CallRecord>>;
  finishCall(workspaceId: string, id: string, status: string): Promise<CallRecord>;
  appendCallEvent(
    workspaceId: string,
    callId: string,
    type: string,
    payload: Record<string, unknown>,
    epoch?: number,
  ): Promise<StoredCallEvent>;
  listCallEvents(
    workspaceId: string,
    callId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<StoredCallEvent>>;
  createEvaluation(input: {
    workspaceId: string;
    releaseId: string;
    status: 'passed' | 'failed';
    fixtures: unknown[];
    createdBy: string;
    id?: string;
  }): Promise<EvaluationRecord>;
  getEvaluation(workspaceId: string, id: string): Promise<EvaluationRecord | undefined>;
  listEvaluations(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<EvaluationRecord>>;
  addUsage(input: Omit<UsageEntry, 'id' | 'createdAt'> & { id?: string }): Promise<UsageEntry>;
  listUsage(
    workspaceId: string,
    callId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<UsageEntry>>;
  audit(input: {
    workspaceId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    payload?: Record<string, unknown>;
  }): Promise<AuditEntry>;
  listAudit(workspaceId: string, limit?: number, cursor?: string): Promise<Page<AuditEntry>>;
  close(): Promise<void>;
}

export interface LocalControlStore extends ControlStore {}
