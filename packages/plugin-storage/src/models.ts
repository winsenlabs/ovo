import type { AgentConfig, OperationStore } from '@winsendotai/ovo-contracts';

export type Role = 'viewer' | 'editor' | 'admin';
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface AgentDraft {
  id: string;
  workspaceId: string;
  config: AgentConfig;
  draftVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface ReleaseRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  draftVersion: number;
  config: AgentConfig;
  plugins: { id: string; version: string }[];
  createdAt: string;
  createdBy: string;
}
export interface CredentialMetadata {
  id: string;
  workspaceId: string;
  label: string;
  provider: string;
  type: string;
  environment: string;
  backend: 'local' | 'aws-secrets-manager';
  currentVersion: number;
  status: 'active' | 'retired';
  permittedAgentIds: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
  retiredAt: string | null;
  fingerprint: string;
}
export interface SecretBlob {
  credentialId: string;
  version: number;
  backend: CredentialMetadata['backend'];
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  authTag: Uint8Array | null;
  backendRef: string | null;
}
export interface ProviderBinding {
  id: string;
  workspaceId: string;
  label: string;
  provider: string;
  environment: string;
  credentialId: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface McpConnection {
  id: string;
  workspaceId: string;
  label: string;
  endpoint: string;
  auth: 'none' | 'bearer';
  credentialId: string | null;
  status: 'unverified' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
}
export interface McpToolApproval {
  workspaceId: string;
  agentId: string;
  toolId: string;
  connectionId: string;
  remoteName: string;
  schemaDigest: string;
  createdAt: string;
  updatedAt: string;
}
export interface McpDiscoveredTool {
  connectionId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaDigest: string;
  discoveredAt: string;
}
export interface CallRecord {
  id: string;
  workspaceId: string;
  releaseId: string;
  kind: 'live' | 'simulation';
  status: string;
  createdAt: string;
  completedAt: string | null;
}
export interface StoredCallEvent {
  id: string;
  callId: string;
  sequence: number;
  at: string;
  type: string;
  epoch: number;
  payload: Record<string, unknown>;
}
export interface EvaluationRecord {
  id: string;
  workspaceId: string;
  releaseId: string;
  status: 'passed' | 'failed';
  fixtures: unknown[];
  createdAt: string;
  createdBy: string;
}
export interface UsageEntry {
  id: string;
  workspaceId: string;
  callId: string;
  provider: string;
  requestId: string;
  quantity: string;
  unit: string;
  priceCardId: string;
  priceCardVersion: string;
  amountMinor: string;
  currency: string;
  state: 'estimated' | 'reconciled';
  createdAt: string;
}
export interface AuditEntry {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface CredentialReferences {
  providerBindings: { total: number; ids: string[] };
  mcpConnections: { total: number; ids: string[] };
}

export interface ControlStore {
  ensureWorkspace(id: string, name?: string): void;
  createAgent(workspaceId: string, config: AgentConfig, id?: string): AgentDraft;
  getAgent(workspaceId: string, id: string): AgentDraft | undefined;
  listAgents(workspaceId: string, limit?: number, cursor?: string): Page<AgentDraft>;
  updateAgent(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    config: AgentConfig,
  ): AgentDraft;
  deleteAgent(workspaceId: string, id: string, expectedVersion: number): void;
  createRelease(input: {
    workspaceId: string;
    agent: AgentDraft;
    plugins: { id: string; version: string }[];
    createdBy: string;
    id?: string;
  }): ReleaseRecord;
  getRelease(workspaceId: string, id: string): ReleaseRecord | undefined;
  listReleases(workspaceId: string, agentId: string): ReleaseRecord[];
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
  }): CredentialMetadata;
  rotateCredential(
    workspaceId: string,
    id: string,
    input: {
      fingerprint: string;
      secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;
    },
  ): CredentialMetadata;
  getCredential(workspaceId: string, id: string): CredentialMetadata | undefined;
  listCredentials(workspaceId: string): CredentialMetadata[];
  getActiveSecretBlob(workspaceId: string, id: string): SecretBlob | undefined;
  credentialReferences(workspaceId: string, id: string, maxIds?: number): CredentialReferences;
  retireCredential(workspaceId: string, id: string): CredentialMetadata;
  createProviderBinding(
    input: Omit<ProviderBinding, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): ProviderBinding;
  getProviderBinding(workspaceId: string, id: string): ProviderBinding | undefined;
  listProviderBindings(workspaceId: string): ProviderBinding[];
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
  ): ProviderBinding;
  deleteProviderBinding(workspaceId: string, id: string): void;
  createMcpConnection(input: {
    workspaceId: string;
    label: string;
    endpoint: string;
    auth: 'none' | 'bearer';
    credentialId?: string | null;
    id?: string;
  }): McpConnection;
  getMcpConnection(workspaceId: string, id: string): McpConnection | undefined;
  listMcpConnections(workspaceId: string): McpConnection[];
  updateMcpConnection(
    workspaceId: string,
    id: string,
    input: {
      label: string;
      endpoint: string;
      auth: 'none' | 'bearer';
      credentialId?: string | null;
    },
  ): McpConnection;
  setMcpConnectionStatus(
    workspaceId: string,
    id: string,
    status: McpConnection['status'],
  ): McpConnection;
  deleteMcpConnection(workspaceId: string, id: string): void;
  replaceMcpDiscoveredTools(
    workspaceId: string,
    connectionId: string,
    tools: Omit<McpDiscoveredTool, 'connectionId' | 'discoveredAt'>[],
  ): McpDiscoveredTool[];
  listMcpDiscoveredTools(workspaceId: string, connectionId: string): McpDiscoveredTool[];
  upsertMcpApproval(input: {
    workspaceId: string;
    agentId: string;
    toolId: string;
    connectionId: string;
    remoteName: string;
    schemaDigest: string;
  }): McpToolApproval;
  getMcpApproval(workspaceId: string, agentId: string, toolId: string): McpToolApproval | undefined;
  listMcpApprovals(workspaceId: string, agentId: string): McpToolApproval[];
  deleteMcpApproval(workspaceId: string, agentId: string, toolId: string): void;
  createCall(input: {
    workspaceId: string;
    releaseId: string;
    kind: 'live' | 'simulation';
    status: string;
    id?: string;
  }): CallRecord;
  getCall(workspaceId: string, id: string): CallRecord | undefined;
  listCalls(workspaceId: string, limit?: number, cursor?: string): Page<CallRecord>;
  finishCall(workspaceId: string, id: string, status: string): CallRecord;
  appendCallEvent(
    workspaceId: string,
    callId: string,
    type: string,
    payload: Record<string, unknown>,
    epoch?: number,
  ): StoredCallEvent;
  listCallEvents(workspaceId: string, callId: string): StoredCallEvent[];
  createEvaluation(input: {
    workspaceId: string;
    releaseId: string;
    status: 'passed' | 'failed';
    fixtures: unknown[];
    createdBy: string;
    id?: string;
  }): EvaluationRecord;
  getEvaluation(workspaceId: string, id: string): EvaluationRecord | undefined;
  listEvaluations(workspaceId: string): EvaluationRecord[];
  addUsage(input: Omit<UsageEntry, 'id' | 'createdAt'> & { id?: string }): UsageEntry;
  listUsage(workspaceId: string, callId: string): UsageEntry[];
  audit(input: {
    workspaceId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    payload?: Record<string, unknown>;
  }): AuditEntry;
  listAudit(workspaceId: string, limit?: number, cursor?: string): Page<AuditEntry>;
}

export interface LocalControlStore extends ControlStore {
  readonly operationStore: OperationStore;
  close(): void;
}
export class DraftConflictError extends Error {
  constructor(public readonly current: AgentDraft) {
    super('The agent draft was updated by another editor.');
    this.name = 'DraftConflictError';
  }
}
export class ReferencedResourceError extends Error {
  constructor(
    message: string,
    public readonly references: unknown,
  ) {
    super(message);
    this.name = 'ReferencedResourceError';
  }
}
